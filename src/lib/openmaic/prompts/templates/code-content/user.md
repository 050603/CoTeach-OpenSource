Create a code playground widget for: {{title}}

## Programming Language

{{programmingLanguage}}

## Challenge Description

{{description}}

## Key Points

{{keyPoints}}

## Starter Code Template

```{{programmingLanguage}}
{{starterCode}}
```

## Test Cases

{{testCases}}

## Hints

{{hints}}

## Course Language

{{pblContext}}

{{languageDirective}}

---

Generate a complete, interactive HTML code editor with:

### Knowledge Teaching (CRITICAL — students must LEARN, not just code)
1. **Objective Alignment**: Turn every supplied Key Point into a learner-facing objective and at least one observable code behavior or test. Do not introduce unrelated concepts merely to make the editor look advanced.
2. **No Decorative Interaction**: Every edit, run, hint, and test must help the student predict, implement, observe, explain, or revise the target concept. Syntax highlighting and animations are support features, not evidence of learning.
3. **Teaching Loop**: Start with a small runnable example and an observation prompt; let the student change one meaningful part; run it; make the output or trace reveal the consequence; then offer another variation and explain the contrast.
4. **Explanatory Feedback**: Identify the relevant line or behavior and explain what happened and why. Treat runtime errors as inspectable program behavior with a local recovery hint, not as an incorrect-answer verdict.
5. **Scaffolded Annotations**: Starter comments must explain intent and reasoning without completing the challenge. Progressive hints should move from concept → strategy → local cue, and preserve the student's ownership of the final code.
6. **Exploration Evidence**: Preserve two runs with a meaningful code or input change and display their outputs side by side or as a trace. End with a short explanation of the observed behavior, not a graded coding challenge.
7. **Assessment Boundary**: This is not a quiz: use no score, answer key, hidden test, correctness verdict, ranking, or pass/fail gate. Visible example checks may describe runtime behavior but must not grade the learner.

### Activity Completion Protocol (MANDATORY)
1. Call `window.__maicActivity.complete()` after meaningful exploration: the learner has run and compared at least two meaningful variants and the behavior explanation is visible. Also add `data-activity-complete` to the final continue control when one exists.
2. Call `window.__maicActivity.reset()` when a full reset clears the comparison history; add `data-activity-reset` to the reset control.
3. Do not signal completion for opening the page, pressing Run once, viewing a hint, or decorative interaction. Completion is a playback milestone, not a grade or mastery claim.

### Interactive Features
1. Code editor with syntax highlighting
2. Run button with output display
3. Visible input/output examples and execution trace comparison
4. Progressive hint system
5. Embedded widget configuration JSON
