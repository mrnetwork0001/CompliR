# yente (OpenSanctions) for CompliR

Self-hosted sanctions matcher used by `src/lib/evidence/yente.ts`. Two containers: the yente API (`ghcr.io/opensanctions/yente:5.5.0`) and a single-node Elasticsearch 9.4.2 index. The manifest is limited to the **sanctions** collection so the first index build is small and quick.

Upstream: compose reference <https://github.com/opensanctions/yente/blob/main/docker-compose.yml> · deploy docs <https://yente.followthemoney.tech/deploy/> · settings <https://yente.followthemoney.tech/settings/> · manifests <https://yente.followthemoney.tech/datasets/> · match API <https://www.opensanctions.org/docs/api/matching/>.

## Run

```bash
docker compose -f docker/yente/docker-compose.yml up -d
# first start downloads + indexes the sanctions collection (~5–10 min)
curl -s http://localhost:8000/healthz
curl -s http://localhost:8000/catalog | head -c 600     # datasets currently indexed
```

Point CompliR at it with `YENTE_URL=http://localhost:8000` (default). `YENTE_DATASET` selects the `/match/{dataset}` segment (`default`; `sanctions` is also valid with this manifest). `YENTE_THRESHOLD` (default 0.7) is the matcher score needed for a hit.

Memory: Elasticsearch is set to a 2 GB heap (`ES_JAVA_OPTS`) — enough for the sanctions scope. Raise to 4 GB if you switch the manifest to `scope: default`. The index lives in the `index-os-data` volume; `docker compose down -v` removes it.

Forcing a refresh: `curl -X POST "http://localhost:8000/updatez?token=$YENTE_UPDATE_TOKEN&sync=true"`. yente also polls hourly on its own.

Data licence: the `data.opensanctions.org` catalog is CC BY-NC 4.0 (non-commercial). For commercial use get a delivery token at <https://www.opensanctions.org/account/bulk/>, set `OPENSANCTIONS_DELIVERY_TOKEN`, and swap the catalog URL in `manifest.yml` to `delivery.opensanctions.com` (commented example included).

## Query examples

Address lookup (what CompliR sends for every subject and funder — `CryptoWallet.publicKey`), plus a name lookup in the same batch:

```bash
curl -s -X POST "http://localhost:8000/match/default?threshold=0.7&limit=5" \
  -H "content-type: application/json" \
  -d '{
    "queries": {
      "a:0": { "schema": "CryptoWallet", "properties": { "publicKey": ["0x8589427373d6d84e98730d7795d8f6f8731fda16"] } },
      "n:0:Person": { "schema": "Person", "properties": { "name": ["Arkadiy Rotenberg"] } }
    }
  }' | jq '.responses | map_values({results: [.results[] | {id, caption, score, match, datasets}]})'
```

Response shape (per query key): `{ status, total, results: [{ id, caption, schema, datasets, score, match, properties, … }] }`. `score` is matcher confidence 0–1; `match` is `score >= threshold`. CompliR maps each result to `SanctionsHit { source: "opensanctions", entityId: id, caption, datasets, score, matchedOn: "address" | "name" }` and reports a hit when `match === true || score >= YENTE_THRESHOLD`.

Note: the address above is the Tornado Cash router listed by OFAC in 2022 — use it only to *query* yente. Never send funds to a real sanctioned address; demo verdicts come from `.data/overrides.json` on wallets we control.

## When yente is down

`screenSanctions()` / `screenAddresses()` return `[]` on connection failure, non-2xx, timeout (4 s) or malformed JSON. The evidence bundle is still produced; the verdict simply lacks the sanctions signal, and `collectEvidenceDetailed().sources.sanctions` reports `timeout_or_error`.
