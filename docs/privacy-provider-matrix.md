# Privacy and provider deployment matrix

DraftApply is open source, but source availability does not determine the retention or training settings of an operator's infrastructure or provider accounts. CV text, job context, questions, and generated output may all be personal data. Verify the settings and policies for the route you actually use.

| Deployment / route | Application persistence | Infrastructure logs | Provider retention / training | ZDR configuration | Who must verify and disclose |
|---|---|---|---|---|---|
| Official extension → official proxy → Groq primary | CV remains in extension storage; the proxy is designed not to persist request content or answers | Render, network, security, and operational metadata may exist; payload logging is disabled by application design | Governed by Groq's current terms and the official account's data controls; repository code cannot prove account-level retention or training settings | The operator must enable and periodically verify Groq ZDR in the Groq Console | DraftApply operator |
| Official proxy → OpenRouter fallback → downstream provider | Same application behavior as above | Render and OpenRouter may process operational metadata; the selected downstream provider is another processor | Depends on both OpenRouter policy and the actually selected model/provider | Proxy requests `zdr: true` and denies data collection by default, but the operator must verify OpenRouter routing/settings and downstream eligibility | DraftApply operator; the response's provider trace identifies the attempted/selected route where available |
| Self-hosted extension → compatible self-hosted proxy → Groq/OpenRouter | Proxy code does not intentionally persist payloads; operator changes may differ | Determined by the operator's host, reverse proxy, observability, Redis, and logging configuration | Determined by the operator's Groq/OpenRouter account and downstream provider | Environment flags express routing requirements; they do not prove provider-account controls | Self-hosting operator |
| Self-hosted proxy → operator-local OpenAI-compatible endpoint | Proxy does not intentionally persist payloads; endpoint behavior is separate | Determined by the proxy operator and local endpoint/runtime | Determined by the endpoint implementation and model host; “local” is not automatically log-free | Hosted-provider ZDR does not apply | Self-hosting operator |
| Local web app → local provider (Ollama, LM Studio, LocalAI) | Backend processes uploads in memory; browser/backend behavior is separate from the extension; provider may cache or log | Local machine, provider process, and OS controls apply | Normally no cloud model provider, but local software settings determine retention; training is not performed by DraftApply | Not applicable unless the selected local service defines such a control | Person operating the local machine/services |
| Local web app → cloud provider | Backend does not intentionally persist CVs/answers, but sends content to the configured cloud provider | Local server plus provider/network metadata may exist | Determined by the selected provider, account tier, and settings | Verify directly with that provider; DraftApply does not enforce a common ZDR contract in the local backend | Local web-app operator/user |

## Important distinctions

- **Application persistence** describes intentional storage by DraftApply code, not backups, platform logs, crash reports, network systems, or modified deployments.
- **Grounding and final validation** reduce unsupported claims in an answer. They do not change where data is sent, establish ZDR, or prevent infrastructure/provider retention.
- OpenRouter is a routing service; its downstream provider can vary. Review `providerTrace`/final-provider metadata and the applicable provider policy.
- Operators should minimize logs, restrict access, set retention periods, protect secrets, disclose every processor, and test deletion/incident procedures before accepting real CVs.

Provider terms and controls can change. Check the relevant provider documentation and account console before deployment and release.
