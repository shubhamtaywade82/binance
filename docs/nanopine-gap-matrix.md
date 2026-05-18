# NanoPine vs Pine Script v6 — Gap Matrix (Current)

Status legend: ✅ implemented · 🟡 partial/workaround · ❌ not implemented

## Type/feature matrix

| Pine v6 concept | NanoPine status | Notes |
|---|---:|---|
| `bool`, `int`, `float`, `string`, `color` | ✅ | Scalar values supported; `input.color` included. |
| `series` qualifier semantics | 🟡 | Runtime has `Series` objects and bar-wise eval, but no explicit qualifier/type checker. |
| `const`, `simple` qualifiers | ❌ | No compile-time type qualifier system yet. |
| `array` | 🟡 | Added as runtime object via `array_*` builtins (no generic type checking). |
| `map` | 🟡 | Added as runtime object via `map_*` builtins (string-keyed; no generic typing). |
| `matrix` | ❌ | No matrix object/ops. |
| `label`, `line` | 🟡 | Added simplified helpers (`label(...)`, `line(...)`) not full object lifecycle API. |
| `box`, `linefill`, `polyline`, `table` | ❌ | Not present. |
| `chart.point` | ❌ | Not present. |
| `footprint`, `volume_row` | ❌ | Not present. |
| user-defined functions | 🟡 | Added `func name(args...) = expr` single-expression form only. |
| function-local scope/advanced semantics | ❌ | No block statements, closures, or strict lexical scope model. |
| full Pine stdlib parity | ❌ | Subset only. |
| compile-time type checker | ❌ | Runtime validations exist; no static type pass yet. |
| richer diagnostics (type mismatch spans/suggestions) | ❌ | Basic parse/runtime errors only. |

## What is feasible now (next near-term phases)

### Phase A (now feasible with current architecture)
- Add more object builtins with simplified APIs (`table_*`, `box_*`, `linefill_*`) emitted through current output channels.
- Expand TA stdlib coverage and utility functions.
- Add stronger runtime argument validation and arity diagnostics.
- Add function safety limits (depth/recursion guards).

### Phase B (requires moderate parser/interpreter extensions)
- Full function bodies with multi-statement blocks and local symbol tables.
- Native container literals and indexing assignment syntax.
- Object-handle model (`label.new`, `label.set_*`, `label.delete`, etc.).

### Phase C (larger compiler/runtime effort)
- Static type system with qualifiers (`const/simple/series`) and inference.
- Broader Pine semantic compatibility (execution model edge-cases, barstate details).
- Conformance tests against Pine reference behavior.
