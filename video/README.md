# CompliR demo film

A 2:39 film made with [Remotion](https://www.remotion.dev). It shows the problem (a sanctioned wallet anyone can still pay, and AI agents that cannot tell who they are paying), what CompliR does about it, and CompliR working live on Arc mainnet.

## What is real

- **The opening event:** the Ronin bridge drain of March 2022 (about $600M), attributed by the FBI to the Lazarus Group, and the exploiter wallet `0x098b716b8aaf21512996dc57eb0615e2383e2f96` added to OFAC's SDN list in April 2022. These are public facts. The screen shows the reported total, $625M; the narration rounds it ("about six hundred million").
- **The verdict on that wallet:** read from the live API (`GET /api/v1/attestation/<address>`, fetched 2026-10-15 14:06 UTC into `src/data.json`): HIGH, score 100, reasons `SANCTIONS_DIRECT`, `USDC_BLACKLISTED`, `PRIOR_HIGH_TIER`, `COMMUNITY_TIP_VERIFIED`, `NETWORK_HELD_ELSEWHERE`, `NO_HISTORY`, limits 0 / 0 USDC, decision `dec_mv9lxtx61ilo24d`.
- **The day on Arc:** CompliR's signed risk dataset for 14 Oct 2026 (`GET /api/v1/stats/2026-10-14`, snapshot signed 23:51 UTC by the attester `0xc742…960c`, hash `0xdf26fbec…4c4646`): 154,029,446 USDC across 2,839 transfers; 727 wallets graded, 381 LOW, 345 MEDIUM, 1 HIGH. "Almost half" and "47%" are 345 of 727. The snapshot was taken before the day closed, so the dataset marks it not final; the screen says "snapshot 23:51 UTC".
- **The product footage:** recorded from the live site https://trycomplir.xyz (production data, dark theme) by `scripts/capture.mjs` (Chrome at 1600×900, device scale 2). The check is a real check: the Ronin address was typed into `/check`, the screening modal ran against the live API and the signed verdict came back after about 18 seconds. The verdict scene cuts from the running modal to the result; the time in between is skipped.
- **The ledger:** 1,969 entries with the hash chain verified (`/api/v1/ledger/verify`, same fetch).
- **The registry:** `AttestationRegistry` at `0xA82EDb5e111c31C63E06EF0007f2fa1a9e7EB30d` on Arc mainnet (chain 5042). The one-line Solidity check is the real interface (`contracts/src/ICompliR.sol`).
- **Watching:** CompliR's blocklist reactor re-grades a wallet when Circle's USDC contract emits `Blacklisted`; the "within a minute" is its 20-second event loop plus a screen.
- **The company:** the screen price (0.0081 USDC) and its history (0.01 → 0.009 → 0.0081, both cuts made by the operator agent within its rules) come from `/api/v1/company`. Revenue is held in Circle Developer-Controlled Wallets; payment is x402 through Circle's facilitator.
- **The refused payout:** the HELD row on `/payouts` is a **test invoice we created**, addressing 50 USDC to the Ronin wallet. The treasury agent held it because the payee is HIGH. The film labels it as a test invoice.
- **Inktoll:** our own sister project, by the same builder. It integrated CompliR with the agent prompt and runs it in production on Arc mainnet; it paid for screens with real USDC. The film calls it a sister project.
- **The problem scene's code card** is an illustration of an agent payment call, not a recording.
- **Logos:** CompliR from `public/brand/` of this repo (the mark is redrawn as an animated SVG from `mark.png`); Arc and Circle are their official SVGs; the USDC mark is from the `cryptocurrency-icons` package, set in USDC blue `#2775CA`.
- **Narration, music and sound:** ElevenLabs. The narrator is Sarah; the verdict line is read by River with a light device treatment, as the product speaking; the score was made with ElevenLabs Music; the 15 sound effects with ElevenLabs sound generation.

## Build it

The ElevenLabs key is read at runtime from `/Users/mrnetwork/Syntura/video/.env` and never stored here.

```
npm install
npm run vo && npm run timing && npm run music && npm run sfx && npm run timing   # audio and timing
npm run capture && npm run encode                                               # footage from trycomplir.xyz
npm run studio                                                                  # preview
node scripts/stills.mjs 191 1661 2366                                           # check stills (half scale)
npm run render4k                                                                # 3840×2160 master (raw audio)
node scripts/finish.mjs out/complir-demo-4k-raw.mp4 out/complir-demo-4k.mp4     # audio to -14 LUFS, TP -1 dBTP
ffmpeg -i out/complir-demo-4k.mp4 -vf scale=1920:1080:flags=lanczos -c:v libx264 -crf 16 -preset slow -c:a copy out/complir-demo-1080p.mp4
npm run poster                                                                  # thumbnail
```

`script.json` holds every spoken line (written form; `scripts/voiceover.mjs` swaps in spoken forms such as "Complier" for CompliR and folds the word timings back). `src/timing.json` places each word on its frame, and the scenes animate on those words.
