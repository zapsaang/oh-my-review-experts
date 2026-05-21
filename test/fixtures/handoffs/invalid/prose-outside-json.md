This file contains prose before the JSON fence.
The prose here is non-whitespace text that appears before the first fenced code block.

```json
{
  "schema_version": "1",
  "task_id": "task-123",
  "agent": "omre-reviewer-security",
  "dimension": "security",
  "status": "completed",
  "target": { "kind": "working-tree", "value": "src/example.ts" },
  "slice_id": "slice-001",
  "findings": [
    {
      "id": "sec-1",
      "severity": "critical",
      "file": "src/example.ts",
      "line": 42,
      "title": "Hardcoded secret",
      "description": "API key is hardcoded in source",
      "evidence": "const API_KEY = 'sk-...'",
      "confidence": "high",
      "classification": "injection"
    }
  ],
  "meta": { "total_findings": 1, "notes": "" }
}
```
