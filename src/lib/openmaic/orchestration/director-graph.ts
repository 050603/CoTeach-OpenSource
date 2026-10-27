/**
 * Director Graph — LangGraph StateGraph for Multi-Agent Orchestration
 *
 * Unified single-round graph topology:
 *
 *   START → director ──(end)──→ END
 *              │
 *              └─(next)→ agent_generate ──→ END
 *
 * Each request runs at most one director→agent cycle. The client serializes
 * multiple requests to drive multi-agent discussions. There is no maxTurns
 * cap — the topology is the bound.
 *
 * The director node adapts its strategy based on agent count:
 *   - Single agent: pure code logic (no LLM). Dispatches the agent on
 *     turn 0, then cues the user on subsequent turns.
 *   - Multi agent: LLM-based decision (with code fast-path for turn 0
 *     trigger agent).
 *
 * Uses LangGraph's custom stream mode: each node pushes StatelessEvent
 * chunks via config.writer() for real-time SSE delivery.
 */

import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { SystemMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { LanguageModel } from 'ai';

import { AISdkLangGraphAdapter } from './ai-sdk-adapter';
import type { StatelessEvent } from '@openmaic/lib/types/chat';
import type { StatelessChatRequest } from '@openmaic/lib/types/chat';
import type { ThinkingConfig } from '@openmaic/lib/types/provider';
import type { AgentConfig } from '@openmaic/lib/orchestration/registry/types';
import { useAgentRegistry } from '@openmaic/lib/orchestration/registry/store';
import { buildNativeToolPrompt, buildStructuredPrompt } from './prompt-builder';
import { summarizeConversation } from './summarizers/conversation-summary';
import { convertMessagesToOpenAI } from './summarizers/message-converter';
import { buildDirectorPrompt, parseDirectorDecision } from './director-prompt';
import { getEffectiveActions } from './tool-schemas';
import type { AgentTurnSummary, WhiteboardActionRecord } from './types';
import { parseStructuredChunk, createParserState, finalizeParser } from './stateless-generate';
import { createLogger } from '@openmaic/lib/logger';
import { createNativeTeachingTools } from './native-teaching-tools';

const log = createLogger('DirectorGraph');

// ==================== State Definition ====================

/**
 * LangGraph state annotation for the orchestration graph
 */
const OrchestratorState = Annotation.Root({
  // Input (set once at graph entry)
  messages: Annotation<StatelessChatRequest['messages']>,
  storeState: Annotation<StatelessChatRequest['storeState']>,
  availableAgentIds: Annotation<string[]>,
  languageModel: Annotation<LanguageModel>,
  thinkingConfig: Annotation<ThinkingConfig | null>,
  discussionContext: Annotation<{ topic: string; prompt?: string } | null>,
  triggerAgentId: Annotation<string | null>,
  userProfile: Annotation<{ nickname?: string; bio?: string } | null>,
  /** Request-scoped agent configs for generated agents (not in the default registry) */
  agentConfigOverrides: Annotation<Record<string, AgentConfig>>,

  // Mutable (updated by nodes)
  currentAgentId: Annotation<string | null>,
  turnCount: Annotation<number>,
  agentResponses: Annotation<AgentTurnSummary[]>({
    reducer: (prev, update) => [...prev, ...update],
    default: () => [],
  }),
  whiteboardLedger: Annotation<WhiteboardActionRecord[]>({
    reducer: (prev, update) => [...prev, ...update],
    default: () => [],
  }),
  shouldEnd: Annotation<boolean>,
  totalActions: Annotation<number>,
});

type OrchestratorStateType = typeof OrchestratorState.State;

/**
 * Look up an agent config: request-scoped overrides first, then global registry.
 * This keeps the server stateless — generated agent configs travel with the request.
 */
function resolveAgent(state: OrchestratorStateType, agentId: string): AgentConfig | undefined {
  return state.agentConfigOverrides[agentId] ?? useAgentRegistry.getState().getAgent(agentId);
}

// ==================== Director Node ====================

/**
 * Unified director: decides which agent speaks next.
 *
 * Strategy varies by agent count:
 *   Single agent — pure code logic, zero LLM calls:
 *     turn 0: dispatch the sole agent
 *     turn 1+: cue user to speak (keeps session active for follow-ups)
 *
 *   Multi agent — LLM-based with code fast-paths:
 *     turn 0 + triggerAgentId: dispatch trigger agent (skip LLM)
 *     otherwise: LLM decides next agent / USER / END
 */
async function directorNode(
  state: OrchestratorStateType,
  config: LangGraphRunnableConfig,
): Promise<Partial<OrchestratorStateType>> {
  const rawWrite = config.writer as (chunk: StatelessEvent) => void;
  const write = (chunk: StatelessEvent) => {
    try {
      rawWrite(chunk);
    } catch {
      /* controller closed after abort */
    }
  };
  const isSingleAgent = state.availableAgentIds.length <= 1;

  // ── Single agent: code-only director ──
  if (isSingleAgent) {
    const agentId = state.availableAgentIds[0] || 'default-1';

    if (state.turnCount === 0) {
      // First turn: dispatch the agent
      log.info(`[Director] Single agent: dispatching "${agentId}"`);
      write({ type: 'thinking', data: { stage: 'agent_loading', agentId } });
      return { currentAgentId: agentId, shouldEnd: false };
    }

    // Agent already responded: cue user for follow-up
    log.info(`[Director] Single agent: cueing user after "${agentId}"`);
    write({ type: 'cue_user', data: { fromAgentId: agentId } });
    return { shouldEnd: true };
  }

  // ── Multi agent: fast-path for first turn with trigger ──
  if (state.turnCount === 0 && state.triggerAgentId) {
    const triggerId = state.triggerAgentId;
    if (state.availableAgentIds.includes(triggerId)) {
      log.info(`[Director] First turn: dispatching trigger agent "${triggerId}"`);
      write({
        type: 'thinking',
        data: { stage: 'agent_loading', agentId: triggerId },
      });
      return { currentAgentId: triggerId, shouldEnd: false };
    }
    log.warn(
      `[Director] Trigger agent "${triggerId}" not in available agents, falling through to LLM`,
    );
  }

  // ── Multi agent: LLM-based decision ──
  const agents: AgentConfig[] = state.availableAgentIds
    .map((id) => resolveAgent(state, id))
    .filter((a): a is AgentConfig => a != null);

  if (agents.length === 0) {
    return { shouldEnd: true };
  }

  write({ type: 'thinking', data: { stage: 'director' } });

  const openaiMessages = convertMessagesToOpenAI(state.messages);
  const conversationSummary = summarizeConversation(openaiMessages);

  const prompt = buildDirectorPrompt(
    agents,
    conversationSummary,
    state.agentResponses,
    state.turnCount,
    state.discussionContext,
    state.triggerAgentId,
    state.whiteboardLedger,
    state.userProfile || undefined,
    state.storeState.whiteboardOpen,
  );

  const adapter = new AISdkLangGraphAdapter(state.languageModel, state.thinkingConfig ?? undefined);

  try {
    const result = await adapter._generate(
      [new SystemMessage(prompt), new HumanMessage('Decide which agent should speak next.')],
      { signal: config.signal } as Record<string, unknown>,
    );

    const content = result.generations[0]?.text || '';
    log.info(`[Director] Raw decision: ${content}`);

    const decision = parseDirectorDecision(content);

    if (decision.shouldEnd || !decision.nextAgentId) {
      log.info('[Director] Decision: END');
      return { shouldEnd: true };
    }

    if (decision.nextAgentId === 'USER') {
      log.info('[Director] Decision: cue USER to speak');
      write({
        type: 'cue_user',
        data: { fromAgentId: state.currentAgentId || undefined },
      });
      return { shouldEnd: true };
    }

    const agentExists = agents.some((a) => a.id === decision.nextAgentId);
    if (!agentExists) {
      log.warn(`[Director] Unknown agent "${decision.nextAgentId}", ending`);
      return { shouldEnd: true };
    }

    write({
      type: 'thinking',
      data: { stage: 'agent_loading', agentId: decision.nextAgentId },
    });

    log.info(`[Director] Decision: dispatch agent "${decision.nextAgentId}"`);
    return {
      currentAgentId: decision.nextAgentId,
      shouldEnd: false,
    };
  } catch (error) {
    log.error('[Director] Error:', error);
    return { shouldEnd: true };
  }
}

function directorCondition(state: OrchestratorStateType): 'agent_generate' | typeof END {
  return state.shouldEnd ? END : 'agent_generate';
}

// ==================== Agent Generate Node ====================

/**
 * Run generation for one agent. Streams agent_start, text_delta,
 * action, and agent_end events via config.writer().
 */
async function runAgentGeneration(
  state: OrchestratorStateType,
  agentId: string,
  config: LangGraphRunnableConfig,
): Promise<{
  contentPreview: string;
  actionCount: number;
  whiteboardActions: WhiteboardActionRecord[];
}> {
  const agentConfig = resolveAgent(state, agentId);
  if (!agentConfig) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const rawWrite = config.writer as (chunk: StatelessEvent) => void;
  const write = (chunk: StatelessEvent) => {
    try {
      rawWrite(chunk);
    } catch (e) {
      log.warn(`[AgentGenerate] write failed for ${agentId}:`, e);
    }
  };
  const messageId = `assistant-${agentId}-${Date.now()}`;

  write({
    type: 'agent_start',
    data: {
      messageId,
      agentId,
      agentName: agentConfig.name,
      agentAvatar: agentConfig.avatar,
      agentColor: agentConfig.color,
    },
  });

  // Compute effective actions: filter by scene type for defense-in-depth
  // e.g. spotlight/laser stripped for non-slide scenes even if in static allowedActions
  const currentScene = state.storeState.currentSceneId
    ? state.storeState.scenes.find((s) => s.id === state.storeState.currentSceneId)
    : undefined;
  const sceneType = currentScene?.type;
  const effectiveActions = getEffectiveActions(agentConfig.allowedActions, sceneType);

  const discussionContext = state.discussionContext || undefined;
  const openaiMessages = convertMessagesToOpenAI(state.messages, agentId);
  const adapter = new AISdkLangGraphAdapter(state.languageModel, state.thinkingConfig ?? undefined);

  const createMessages = (systemPrompt: string) => {
    const messages = [
      new SystemMessage(systemPrompt),
      ...openaiMessages.map((message) =>
        message.role === 'user'
          ? new HumanMessage(message.content)
          : new AIMessage(message.content),
      ),
    ];
    const lastMessage = messages[messages.length - 1];
    if (!messages.some((message) => message instanceof HumanMessage)) {
      messages.push(new HumanMessage('Please begin.'));
    } else if (lastMessage instanceof AIMessage) {
      messages.push(
        new HumanMessage("It's your turn to speak. Respond from your perspective."),
      );
    }
    return messages;
  };

  let fullText = '';
  let actionCount = 0;
  const whiteboardActions: WhiteboardActionRecord[] = [];

  const emitText = (content: string) => {
    const text = content.replace(/^>+\s?/gm, '');
    if (!text) return;
    fullText += text;
    write({ type: 'text_delta', data: { content: text, messageId } });
  };

  const emitAction = (
    actionId: string,
    actionName: string,
    params: Record<string, unknown>,
  ) => {
    if (!effectiveActions.includes(actionName)) {
      log.warn(
        `[AgentGenerate] Agent ${agentConfig.name} attempted disallowed action: ${actionName}, skipping`,
      );
      return;
    }
    actionCount++;
    if (actionName.startsWith('wb_')) {
      whiteboardActions.push({
        actionName: actionName as WhiteboardActionRecord['actionName'],
        agentId,
        agentName: agentConfig.name,
        params,
      });
    }
    write({
      type: 'action',
      data: { actionId, actionName, params, agentId, messageId },
    });
  };

  const runStructuredFallback = async () => {
    const parserState = createParserState();
    const prompt = buildStructuredPrompt(
      agentConfig,
      state.storeState,
      discussionContext,
      state.whiteboardLedger,
      state.userProfile || undefined,
      state.agentResponses,
    );
    for await (const chunk of adapter.streamGenerate(createMessages(prompt), {
      signal: config.signal,
    })) {
      if (chunk.type !== 'delta') continue;
      const parseResult = parseStructuredChunk(chunk.content, parserState);
      let emittedTextCount = 0;
      for (const entry of parseResult.ordered) {
        if (entry.type === 'text') {
          const text = parseResult.textChunks[entry.index];
          if (text) emitText(text);
          emittedTextCount++;
        } else {
          const action = parseResult.actions[entry.index];
          if (action) emitAction(action.actionId, action.actionName, action.params);
        }
      }
      for (let index = emittedTextCount; index < parseResult.textChunks.length; index++) {
        const text = parseResult.textChunks[index];
        if (text) emitText(text);
      }
    }
    const finalResult = finalizeParser(parserState);
    for (const entry of finalResult.ordered) {
      if (entry.type !== 'text') continue;
      const text = finalResult.textChunks[entry.index];
      if (text) emitText(text);
    }
  };

  const useNativeTools = process.env.OPENMAIC_NATIVE_CLASSROOM_TOOLS !== 'false';
  try {
    if (!useNativeTools) {
      await runStructuredFallback();
    } else {
      const nativePrompt = buildNativeToolPrompt(
        agentConfig,
        state.storeState,
        discussionContext,
        state.whiteboardLedger,
        state.userProfile || undefined,
        state.agentResponses,
      );
      const tools = createNativeTeachingTools(effectiveActions);
      for await (const chunk of adapter.streamGenerate(createMessages(nativePrompt), {
        tools,
        signal: config.signal,
      })) {
        if (chunk.type === 'delta') {
          emitText(chunk.content);
        } else if (chunk.type === 'tool_calls') {
          for (const toolCall of chunk.toolCalls) {
            let params: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(toolCall.function.arguments) as unknown;
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                params = parsed as Record<string, unknown>;
              }
            } catch (error) {
              log.warn(`[AgentGenerate] Invalid tool arguments for ${toolCall.function.name}:`, error);
              continue;
            }
            emitAction(toolCall.id, toolCall.function.name, params);
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    if (useNativeTools && fullText.length === 0 && actionCount === 0) {
      log.warn(
        `[AgentGenerate] Native tools unavailable for ${agentConfig.name}; retrying with structured Action DSL`,
        error,
      );
      try {
        await runStructuredFallback();
      } catch (fallbackError) {
        log.error(`[AgentGenerate] Structured fallback failed for ${agentConfig.name}:`, fallbackError);
        write({
          type: 'error',
          data: {
            message:
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          },
        });
      }
    } else {
      log.error(`[AgentGenerate] Error for ${agentConfig.name}:`, error);
      write({
        type: 'error',
        data: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  write({
    type: 'agent_end',
    data: { messageId, agentId },
  });

  return {
    contentPreview: fullText.slice(0, 300),
    actionCount,
    whiteboardActions,
  };
}

/**
 * Agent generate node — runs one agent, then loops back to director.
 */
async function agentGenerateNode(
  state: OrchestratorStateType,
  config: LangGraphRunnableConfig,
): Promise<Partial<OrchestratorStateType>> {
  const agentId = state.currentAgentId;
  if (!agentId) {
    return { shouldEnd: true };
  }

  const agentConfig = resolveAgent(state, agentId);
  const result = await runAgentGeneration(state, agentId, config);

  if (!result.contentPreview && result.actionCount === 0) {
    log.warn(
      `[AgentGenerate] Agent "${agentConfig?.name || agentId}" produced empty response (no text, no actions)`,
    );
  }

  return {
    turnCount: state.turnCount + 1,
    totalActions: state.totalActions + result.actionCount,
    agentResponses: [
      {
        agentId,
        agentName: agentConfig?.name || agentId,
        contentPreview: result.contentPreview,
        actionCount: result.actionCount,
        whiteboardActions: result.whiteboardActions,
      },
    ],
    whiteboardLedger: result.whiteboardActions,
    currentAgentId: null,
  };
}

// ==================== Graph Construction ====================

/**
 * Create the orchestration LangGraph StateGraph.
 *
 * Topology:
 *   START → director ──(end)──→ END
 *              │
 *              └─(next)→ agent_generate ──→ END
 *
 * Single-round contract: each request runs at most one director→agent cycle.
 * Multi-agent discussions arise from the client serializing requests; the
 * server graph does not loop. There is no `maxTurns` — the topology itself
 * is the bound.
 */
export function createOrchestrationGraph() {
  const graph = new StateGraph(OrchestratorState)
    .addNode('director', directorNode)
    .addNode('agent_generate', agentGenerateNode)
    .addEdge(START, 'director')
    .addConditionalEdges('director', directorCondition, {
      agent_generate: 'agent_generate',
      [END]: END,
    })
    .addEdge('agent_generate', END);

  return graph.compile();
}

/**
 * Build initial state for the orchestration graph from a StatelessChatRequest
 * and a pre-created LanguageModel instance.
 */
export function buildInitialState(
  request: StatelessChatRequest,
  languageModel: LanguageModel,
  thinkingConfig?: ThinkingConfig,
): typeof OrchestratorState.State {
  // Build request-scoped agent config overrides for generated agents.
  // These travel with each request — no server-side persistence needed.
  const agentConfigOverrides: Record<string, AgentConfig> = {};
  if (request.config.agentConfigs?.length) {
    for (const cfg of request.config.agentConfigs) {
      agentConfigOverrides[cfg.id] = {
        ...cfg,
        isDefault: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }
  }

  const discussionContext = request.config.discussionTopic
    ? {
        topic: request.config.discussionTopic,
        prompt: request.config.discussionPrompt,
      }
    : null;

  const incoming = request.directorState;
  const turnCount = incoming?.turnCount ?? 0;

  return {
    messages: request.messages,
    storeState: request.storeState,
    availableAgentIds: request.config.agentIds,
    languageModel,
    thinkingConfig: thinkingConfig ?? null,
    discussionContext,
    triggerAgentId: request.config.triggerAgentId || null,
    userProfile: request.userProfile || null,
    agentConfigOverrides,
    currentAgentId: null,
    turnCount,
    agentResponses: incoming?.agentResponses ?? [],
    whiteboardLedger: incoming?.whiteboardLedger ?? [],
    shouldEnd: false,
    totalActions: 0,
  };
}
