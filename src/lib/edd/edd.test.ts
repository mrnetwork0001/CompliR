import "../__tests__/setup";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { migrate } from "../store";
import { listDecisions, getDecision } from "../ledger";
import { decisionHash } from "../attest/canonical";

const screenMock = vi.fn();
vi.mock("../pipeline", () => ({ screen: (...a: unknown[]) => screenMock(...a) }));

import { createEddRequest, getEddRequest, answerEdd, listOpenEdd, answersHash, toPublicView, EddError } from "./index";

const subject = "0x000000000000000000000000000000000000edd1" as const;
const questions = ["What is the source of the funds?", "Who controls this wallet?"];

beforeAll(async () => { await migrate(); });

describe("EDD answer flow", () => {
  it("create → get → answer round trip (mock screen), hash in ledger, rescreen recorded", async () => {
    screenMock.mockResolvedValue({ decisionId: "dec_rescreen1", tier: "LOW", score: 5 });
    const { id, url } = await createEddRequest({ subject, decisionId: "dec_orig1", questions });
    expect(id).toMatch(/^edd_[0-9a-f]{24}$/);
    expect(url).toBe(`http://localhost:3000/edd/${id}`);

    const open = await listOpenEdd(10);
    expect(open.some((r) => r.id === id)).toBe(true);
    const r0 = await getEddRequest(id);
    expect(r0?.status).toBe("OPEN");
    expect(r0?.questions).toEqual(questions);
    expect(toPublicView(r0!)).not.toHaveProperty("response");
    expect(toPublicView(r0!).subjectMasked).toContain("…");

    const answers = ["Invoice payments from Acme Ltd", "Our treasury multisig"];
    const res = await answerEdd(id, answers, "ops@example.com");
    expect(res.status).toBe("ANSWERED");
    expect(res.answersHash).toBe(answersHash(id, answers));
    expect(res.answersHash).toBe(decisionHash({ eddId: id, answers }));
    expect(res.rescreen).toEqual({ decisionId: "dec_rescreen1", tier: "LOW", previousTier: null, changed: false, score: 5 });
    expect(screenMock).toHaveBeenCalledWith({ address: subject, clientId: "edd" }, { kind: "RESCREEN" });

    // ledger entry: hash only, no answer text
    const entry = await getDecision(res.ledgerEntryId);
    expect(entry?.kind).toBe("EDD_RESPONSE");
    const payload = entry!.payload as Record<string, unknown>;
    expect(payload.answersHash).toBe(res.answersHash);
    expect(payload.eddId).toBe(id);
    expect(JSON.stringify(payload)).not.toContain("Acme");
    expect((await listDecisions({ subject })).some((d) => d.kind === "EDD_RESPONSE")).toBe(true);

    // stored privately on the request
    const r1 = await getEddRequest(id);
    expect(r1?.status).toBe("ANSWERED");
    expect(r1?.response?.answers).toEqual(answers);
    expect(r1?.response?.contact).toBe("ops@example.com");
    expect(r1?.response?.rescreen?.decisionId).toBe("dec_rescreen1");
    expect(r1?.response?.ledgerEntryId).toBe(res.ledgerEntryId);
    const pub = toPublicView(r1!);
    expect(JSON.stringify(pub)).not.toContain("Acme");
    expect(pub.rescreen?.tier).toBe("LOW");
  });

  it("rejects a second answer", async () => {
    screenMock.mockResolvedValue({ decisionId: "dec_rescreen2", tier: "MEDIUM", score: 40 });
    const { id } = await createEddRequest({ subject, decisionId: "dec_orig2", questions: ["Q1"] });
    await answerEdd(id, ["first"]);
    await expect(answerEdd(id, ["second"])).rejects.toMatchObject({ code: "ALREADY_ANSWERED" });
    expect((await getEddRequest(id))?.response?.answers).toEqual(["first"]);
  });

  it("validates answer count and length; rescreen failure keeps the answer", async () => {
    const { id } = await createEddRequest({ subject, decisionId: "dec_orig3", questions: ["Q1", "Q2"] });
    await expect(answerEdd(id, ["only one"])).rejects.toBeInstanceOf(EddError);
    await expect(answerEdd(id, ["x".repeat(1001), "ok"])).rejects.toMatchObject({ code: "VALIDATION" });
    screenMock.mockRejectedValueOnce(new Error("rpc down"));
    const res = await answerEdd(id, ["a", "b"]);
    expect(res.rescreen).toBeNull();
    expect(res.rescreenError).toContain("rpc down");
    expect((await getEddRequest(id))?.status).toBe("ANSWERED");
  });

  it("previousTier comes from the original decision; changed flag set", async () => {
    const { appendDecision } = await import("../ledger");
    const orig = await appendDecision({ kind: "SCREEN", subject, clientId: null, payload: { tier: "HIGH", score: 70 } });
    screenMock.mockResolvedValue({ decisionId: "dec_rescreen4", tier: "MEDIUM", score: 30 });
    const { id } = await createEddRequest({ subject, decisionId: orig.id, questions: ["Q1"] });
    const res = await answerEdd(id, ["answer"]);
    expect(res.rescreen).toMatchObject({ previousTier: "HIGH", tier: "MEDIUM", changed: true });
  });
});
