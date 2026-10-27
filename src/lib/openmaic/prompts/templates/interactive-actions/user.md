Title: {{title}}
Concept: {{conceptName}}
Description: {{description}}
Design Idea: {{designIdea}}
Key Points: {{keyPoints}}
Widget Type: {{widgetType}}
Widget Config JSON: {{widgetConfig}}

Element Inventory (extracted from the generated widget HTML; prefer these real selectors):
{{elementInventory}}

{{courseContext}}
{{agents}}
{{pblContext}}
{{timingBudget}}

**Language Directive**: {{languageDirective}}

Output as a JSON array directly (no explanation, no code fences, 3-8 speech/widget-action items). Include a concise guidance speech first and a separate feedback/transition speech last; the runtime inserts the student activity gate after the first speech:
[{"type":"text","content":"Adjust the main control and observe what changes."},{"type":"action","name":"widget_highlight","params":{"target":"#main-control","content":"Focus on this control."}},{"type":"text","content":"Your observation shows how the two quantities are connected; keep that relationship in mind as we continue."}]
