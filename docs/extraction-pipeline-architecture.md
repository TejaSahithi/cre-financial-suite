# Extraction Pipeline Architecture (as currently running)

This documents what the code actually executes today, not what filenames imply.
Azure Document Intelligence is the only document parser and OpenAI is the
only LLM provider — the Vertex AI / Gemini / Google Vision / Docling
compatibility wrappers and the `parse-pdf-docling` alias route have been
removed. One naming carryover remains:

- **"Docling" is still used as a type/field name** (`DoclingOutput`, the `uploaded_files.docling_raw` column). Actual parsing is done by **Azure Document Intelligence**, adapted into the (renamed-in-spirit-only) Docling shape for compatibility with already-persisted data (`_shared/extraction/azure-layout-adapter.ts`). A new `azure_raw_response` column is now dual-written alongside `docling_raw` as the canonical name going forward; `docling_raw` is scheduled for removal in a later migration once verified unused.

---

## 1. End-to-end request flow (upload → compute)

```mermaid
flowchart TD
    U["User: LeaseUpload.jsx\n+ FileUploader.jsx"] -->|"invokeEdgeFunctionFormData"| UH[upload-handler]
    UH -->|"creates uploaded_files row\nstatus=uploaded"| DB1[(uploaded_files)]
    UH --> CU[confirm-upload]
    CU -->|"status=confirmed"| IF[ingest-file]

    IF -->|"detects module_type / document_subtype\nfile-detector.ts"| ROUTE{PDF lease?}

    ROUTE -->|sync path| PPD[parse-document-azure]
    ROUTE -->|"async fire-and-forget\nfor lease PDFs"| LEW[lease-extraction-worker]

    PPD -->|"delegates to\nparser.ts -> Azure Document Intelligence"| AZURE[(Azure Document\nIntelligence)]
    AZURE -->|"docling_raw + azure_raw_response\npersisted, status=pdf_parsed"| DB1
    PPD --> NPO[normalize-pdf-output]

    NPO -->|"business-extraction-orchestrator.ts\nchooses mode"| ORCH{Extraction mode}
    ORCH -->|"openai_fact_ledger /\nopenai_primary_legacy_fallback"| LLMX[OpenAI extraction\nsee diagram 2]
    ORCH -->|"legacy_hybrid fallback"| RULE["legacy rule/table/LLM\npipeline.ts 6-step engine"]

    LLMX --> NRM["normalized_output\nui_review_payload\nparsed_data"]
    RULE --> NRM
    NRM -->|"status=review_required\nor validated"| DB1

    LEW -->|"runs parse -> normalize ->\nreview_draft -> rule_extraction\nitself, same OpenAI calls"| DB1
    LEW -->|"progress tracked per stage"| PJ[(pipeline_jobs)]

    DB1 -->|"polled every 3s via\npipeline-status"| REVIEWUI["LeaseReview.jsx\n(human review screen)"]

    REVIEWUI -->|approve| RA[review-approve]
    REVIEWUI -->|reject| RJA[reject-lease-abstract]
    REVIEWUI -->|"needs re-extraction"| SLB[send-lease-back-for-reextraction]

    RA --> VAL[validate-data]
    VAL --> STORE[store-data]
    STORE --> COMPUTE["compute-lease / compute-cam /\ncompute-expense / compute-revenue /\ncompute-budget / compute-reconciliation"]
    COMPUTE --> CR[(compute_runs)]

    style AZURE fill:#264653,color:#fff
    style LLMX fill:#e76f51,color:#fff
    style DB1 fill:#2a9d8f,color:#fff
    style PJ fill:#2a9d8f,color:#fff
    style CR fill:#2a9d8f,color:#fff
```

---

## 2. Inside one OpenAI extraction call (normalize → schema → prompt → response)

```mermaid
flowchart TD
    A["Raw Azure DI output\n(docling_raw)"] --> B["normalizeDoclingOutput\npipeline.ts:49-110\nclean OCR noise, dedup headers"]
    B --> C["normalizeExtractedData\nnormalizer.ts:198-386\nfield-name aliasing per module\n(LEASE_FIELD_ALIASES etc.)"]

    C --> D["getFieldGroups(moduleType)\nschemas.ts:1541-1703\ne.g. parties, dates, financial,\nexpense_recovery, cam_structure"]

    D --> E["buildFieldGroupPrompt\nllm-extractor.ts:191-248"]
    E --> F["+ LLM_SYSTEM_PROMPT\nllm-extractor.ts:32-187\n(entity-vs-person rules,\ndate inference, few-shot examples)"]
    F --> G["+ per-group hint text\nfrom schemas.ts"]
    G --> H["+ mode framing\n(isFileMode: Azure DI text vs OCR snippet)"]
    H --> I["+ documentSubtype hint\n(profile classifier only)"]

    I --> J["_shared/llm.ts\ncallLLMJSON()\ntemperature=0, response_format=json_object"]
    J --> K{{"POST https://api.openai.com\n/v1/chat/completions\nmodel=gpt-4o-mini"}}

    K -->|success| L["parseLLMResponse /\nparseFactsResponse\nmap JSON keys -> expectedFields"]
    K -->|failure| M["LLMProviderError classified:\nauth / rate_limit / timeout /\ninvalid_response / context_length /\ncontent_filter"]

    L --> N["normalizeLlmEvidence\nllm-extractor.ts:315-334\nwrap each field:\n{value, sourceText, sourcePage, confidence}\nclamp confidence 0-1"]

    N --> O["normalizeLease (type coercion)\nlease-normalizer.ts:19-252\nstrip $/commas, ISO dates,\nbooleans, derive annual<->base rent"]

    O --> P["business-extraction-acceptance.ts:24-201\nclassify: accepted / accepted_needs_review /\nfallback_eligible / rejected"]

    M --> Q["fallback to legacy_hybrid\n(rule/table extraction)"]
    P -->|fallback_eligible| Q

    P -->|accepted*| R["persisted to uploaded_files:\nnormalized_output, ui_review_payload"]
    Q --> R

    style K fill:#e76f51,color:#fff
    style J fill:#e76f51,color:#fff
```

---

## 3. `extract-lease-expense-rules` (separate standalone extractor)

Used specifically for CAM/expense recovery clauses, not part of the field-group pipeline above.

```mermaid
sequenceDiagram
    participant UI as LeaseReview.jsx
    participant EF as extract-lease-expense-rules
    participant LLM as OpenAI (gpt-4o-mini)
    participant DB as lease_expense_rules table

    UI->>EF: invoke({ lease_id, full_text })
    EF->>EF: chunk full paragraph text if long
    EF->>LLM: prompt (promptVersion "expense-rules-v3"/"-chunk")\nfields: category_name, recoverable_from_tenant,\ncam_eligible, recovery_method, cap_type,\nbase_year, exact_source_text, confidence_score\ntemperature=0.1
    LLM-->>EF: JSON array of rule candidates
    EF->>EF: normalizeDecision / normalizeText / toNullableNumber\n(index.ts:323-364)
    EF->>DB: persist normalized rules
    DB-->>UI: rules shown for human approval
    UI->>EF: approve-lease-expense-rule / reject-lease-expense-rule
```

---

## 4. Review status state machine

```mermaid
stateDiagram-v2
    [*] --> uploaded
    uploaded --> parsing: confirm-upload
    parsing --> pdf_parsed: Azure DI success
    pdf_parsed --> review_required: normalize-pdf-output\n(extraction needs human check)
    pdf_parsed --> validated: normalize-pdf-output\n(high confidence, auto-clear)
    parsing --> review_required: parse failure\n(parkForManualReview /\npersistBlockedParse fallback)

    review_required --> pending: reviewer opens LeaseReview.jsx
    pending --> approved: review-approve
    pending --> rejected: reject-lease-abstract
    pending --> pending: send-lease-back-for-reextraction\n(re-run normalize-pdf-output)

    approved --> validate_data: validate-data
    validate_data --> stored: store-data
    stored --> computed: compute-lease / compute-cam / ...
    computed --> [*]

    rejected --> [*]
```

---

## 5. Job orchestration (`pipeline_jobs`)

No cron — jobs are dispatched via direct `fetch` calls between edge functions, tracked durably in `pipeline_jobs` for retry/resume.

```mermaid
flowchart LR
    IF[ingest-file] -->|"fire-and-forget fetch\n(lease PDFs only)"| LEW[lease-extraction-worker]
    LEW --> S1["stage=parse"]
    S1 --> S2["stage=normalize"]
    S2 --> S3["stage=review_draft"]
    S3 --> S4["stage=rule_extraction"]

    S1 & S2 & S3 & S4 -.writes progress.-> PJ[("pipeline_jobs\nstatus: queued/running/\ncompleted/failed/cancelled\nattempt / max_attempts / available_at")]

    PJ -.retry backoff.-> LEW

    subgraph "Failure recovery"
        direction TB
        F1["Detect contradictory state:\nstatus=review_required but\ndocling_raw is valid Azure success"]
        F2["Repair: resume at 'normalize'\nstage instead of re-parsing\n(no longer overwrites good Azure output)"]
        F1 --> F2
    end
```

---

## Quick reference: which file does what

| Stage | Edge function / module | Provider called |
|---|---|---|
| Intake | `upload-handler`, `confirm-upload` | — |
| Route | `ingest-file`, `_shared/file-detector.ts` | — |
| Parse | `parse-document-azure` → `_shared/extraction/parser.ts` | **Azure Document Intelligence** |
| Normalize (text cleanup) | `_shared/extraction/pipeline.ts` (`normalizeDoclingOutput`) | — |
| Normalize (field aliasing) | `_shared/normalizer.ts` | — |
| Normalize (type coercion) | `_shared/lease-normalizer.ts` | — |
| Field/fact extraction | `normalize-pdf-output` → `business-extraction-orchestrator.ts` → `llm-extractor.ts` / `openai-fact-ledger/fact-ledger-extractor.ts` | **OpenAI `gpt-4o-mini`** (via `_shared/llm.ts`) |
| Expense-rule extraction | `extract-lease-expense-rules` | **OpenAI `gpt-4o-mini`** |
| Background durable worker | `lease-extraction-worker` + `pipeline_jobs` | Azure DI + OpenAI |
| Human review | `LeaseReview.jsx`, `review-approve`, `reject-lease-abstract`, `send-lease-back-for-reextraction` | — |
| Validate/store | `validate-data`, `store-data` | — |
| Compute | `compute-lease`, `compute-cam`, `compute-expense`, `compute-revenue`, `compute-budget`, `compute-reconciliation` | deterministic, no LLM |

**Dormant/legacy code, not on the live path:** `extract-document-fields` (HTTP 410, deprecated). The `vertex-ai.ts` Gemini-compat client and `phase52-vertex-diagnostic` route described in earlier revisions of this doc have since been deleted entirely, along with the `parse-pdf-docling`/`ocr-vision-extract` alias routes.
