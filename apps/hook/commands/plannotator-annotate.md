---
description: Open interactive annotation UI for a markdown file or folder
allowed-tools: Bash(plannotator:*)
disable-model-invocation: true
---

## Markdown Annotations

!`plannotator annotate $ARGUMENTS`

## Your task

If the output above is empty, OR is a JSON object whose `"decision"` is `"approved"` or `"dismissed"`, the user closed the annotation session without requesting changes. Acknowledge with a single sentence ("Annotation session closed.") and stop. Do not begin any work.

Otherwise the output is either plaintext annotation feedback or a JSON object with `"decision": "annotated"` and a `"feedback"` field. Address the feedback — the user has reviewed the markdown file(s) and provided specific annotations and comments.
