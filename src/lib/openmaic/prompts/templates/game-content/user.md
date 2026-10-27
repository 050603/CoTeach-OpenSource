Create an educational GAME widget for: {{title}}

## Game Type

{{gameType}}

## Description

{{description}}

## Key Points

{{keyPoints}}

## Legacy Scoring Configuration (do not expose as a knowledge grade)

{{scoring}}

## Language

{{pblContext}}

{{languageDirective}}

---

Generate a FUN, INTERACTIVE HTML game with these MANDATORY features:

### Knowledge Teaching (CRITICAL — students must LEARN, not just play)
1. **Objective Alignment**: Map every supplied Key Point to a decision, rule, variable, or strategy that the player can explore. State the learning objective before play; never add unrelated trivia for variety.
2. **No Decorative Interaction**: The mechanic must let the student predict, apply, observe, or revise the target knowledge. Random rewards and animations may increase engagement but cannot replace a meaningful model consequence.
3. **Teaching Loop**: Use a brief demonstration, invite a plan, let the learner act, make the consequence visible, then explain it and offer another route or parameter state to try.
4. **Explanatory Feedback**: After meaningful actions, explain what happened and why using the player's actual control state and the relevant Key Point. Give a targeted next experiment rather than an answer verdict.
5. **Open Operation**: Prefer forgiving controls, multiple viable strategies, sandbox replay, construction, tuning, timing, or simulation. Do not use a single canonical knowledge answer as the win condition.
6. **Exploration Evidence**: Preserve meaningful attempts or strategies and finish with a comparison of their consequences. Game completion is a playback milestone, not proof of mastery.
7. **Assessment Boundary**: This is not a quiz: use no score, answer key, matching, sorting, ordering, drag-to-answer, correctness verdict, ranking, or pass/fail gate. Ignore legacy scoring input except for optional neutral progress visualization.

### Activity Completion Protocol (MANDATORY)
1. Call `window.__maicActivity.complete()` after meaningful exploration: the learner has tried the core mechanic in at least two meaningful states and the consequence comparison is visible. Also add `data-activity-complete` to the final continue control when one exists.
2. Call `window.__maicActivity.reset()` when a full restart clears the attempt history; add `data-activity-reset` to the reset control.
3. Do not signal completion for starting the game, one click, finishing an animation, or decorative interaction. Completion is not a grade or mastery claim.

### Game Design (CRITICAL - NOT A QUIZ!)
1. **Interactive gameplay**: Player MUST control something meaningful (NOT just click answers)
2. **Real game mechanics**: Tuning, aiming, balancing, navigating, constructing, controlling, or experimenting
3. **Skill-based operation**: The learner's controls visibly change the modeled outcome
4. **Engaging feedback**: Animations, sounds, visual effects for actions

### Preferred Game Types (in order of preference)
1. **Physics/Action**: Control parameters to achieve a goal (land safely, hit target, balance)
2. **Construction**: Assemble a working model where parts have functional consequences and multiple viable layouts
3. **Strategy sandbox**: Compare decisions and resource trade-offs without one answer key
4. **Simulation game**: Let the player experiment with variables and compare outcomes

### Simulation Integration (if game has visual simulation)
- Simulation MUST be interactive (player controls something)
- Simulation physics MUST match what player is learning
- Visual feedback MUST show player's progress toward goal
- Example: Don't ask "What thrust?" → LET PLAYER ADJUST thrust and see result!

### Game Elements
1. **Clear objective**: "Explore stable flight", "Compare trajectories", "Build a working system"
2. **Player controls**: Sliders, buttons, drag areas, or click targets
3. **Real-time feedback**: State traces, progress cues, and consequence indicators
4. **Scenarios**: Progressively richer parameter combinations
5. **Discovery markers**: Optional badges for trying meaningfully different strategies, never for right answers
6. **Replay value**: Multiple routes, parameters, or solutions

### Visual Design
1. Attractive theme matching the subject
2. Clear UI for controls and feedback
3. Animations for success/failure
4. Responsive layout (mobile + desktop)

### Technical (MANDATORY)
1. **Inline onclick for start button**: `<button onclick="startGame()">开始</button>` - NOT addEventListener
2. **Custom CSS preferred**: Avoid Tailwind `@layer utilities` blocks; use plain CSS
3. **DOMContentLoaded wrapper**: Wrap game code in `document.addEventListener('DOMContentLoaded', ...)`
4. **Global start function**: `function startGame()` must be callable from onclick
5. Embedded `<script type="application/json" id="widget-config">`
6. `requestAnimationFrame` for smooth animations
7. Touch-friendly controls (min 44px touch targets)
8. localStorage for explored scenarios and learner-created configurations, without scores or rankings
9. Pause functionality

### Output
Return ONLY the HTML document. Make the game FUN enough that students want to play again — but ensure they LEARN the key concepts while playing!
