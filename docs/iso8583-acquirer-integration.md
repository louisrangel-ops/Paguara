# Paguara — ISO 8583 acquiring integration (foundation)

Status: **development-only, NOT production-ready**. The codec is a deliberately constrained ASCII **test profile**, not a network-certified protocol implementation. It does not transmit cardholder data, open sockets, or register a live rail.

## Existing integration boundary
- `RailAdapter.charge` is the current payment connector interface.
- `buildRails` still registers only SandboxRail; LIVEMODE guard remains unchanged.
- `card_national` uses `ves_card_switch`; `card_international` uses `offshore_card`. Neither has a live connector.
- Do not turn on live processing merely by changing `LIVEMODE`.

## Deliverable in this branch
- A minimal strict bitmap / fixed ASCII / LLVAR codec, usable only with the declared test field profile.
- Tests for round-trip and rejection of malformed inputs.
- No PAN handling in logs, no production credentials, no network connection.

## Required acquiring specifications before the next phase
1. Acquirer protocol revision, exact field table (DE 22/25/48/55/60/61/62/123), binary vs ASCII and character sets, lengths and headers.
2. Message flows for auth, completion/capture, financial requests, advice, reversal and network management.
3. Transport framing, TLS/mTLS, key management, MAC/HSM requirements, timeouts, echo and reconnect.
4. Card-on-file, MIT/CIT, ECI, CAVV/AAV, DS transaction ID, 3DS server integration, tokenization.
5. Certification host, test cards, response codes, reconciliation and settlement file formats.
6. PCI DSS scope and card-data vault/provider; no sensitive authentication data storage.

## Next implementation gates
- Extend RailAdapter with authorization status lookup, reversal, and settlement reconciliation contracts, without breaking existing rails.
- Build profile-driven binary/ASCII packager and framed TLS transport for the actual acquirer.
- Persist unique attempt, STAN/RRN, transmission and unknown-result status safely, avoiding PAN/CVV.
- Handle unknown timeouts by status inquiry/reconciliation, never blind re-charge.
- Build issuer simulator, fuzz/negative tests, 3DS integration tests, and acquiring certification.
- Keep live feature disabled until credentials, certification, security review, operational runbooks and rollback approval.
