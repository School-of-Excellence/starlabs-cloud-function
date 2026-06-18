const {
  extractAssistantFinalJson,
  buildUpLifeAspirationReport,
  pickPreviousStage,
  shouldStartPod,
} = require("../../components/atc_helpers");

describe("TCH.1 extractAssistantFinalJson", () => {
  test("(a) text with assistantfinal marker then JSON object -> parsed object", () => {
    const raw = 'some reasoning here assistantfinal {"verdict":"pass","score":5}';
    expect(extractAssistantFinalJson(raw)).toEqual({ verdict: "pass", score: 5 });
  });

  test("(b) nested braces and braces inside string values -> correct object", () => {
    const raw =
      'assistantfinal {"a":{"b":1},"note":"this } has { braces","arr":[{"x":2}]}';
    expect(extractAssistantFinalJson(raw)).toEqual({
      a: { b: 1 },
      note: "this } has { braces",
      arr: [{ x: 2 }],
    });
  });

  test("(c) malformed JSON after marker -> returns raw substring (string), no throw", () => {
    const raw = 'assistantfinal {"a":1,}'; // trailing comma -> invalid JSON
    const result = extractAssistantFinalJson(raw);
    expect(typeof result).toBe("string");
    expect(result).toBe('{"a":1,}');
  });

  test("(d) non-string input (object) -> returned as-is", () => {
    const obj = { already: "parsed" };
    expect(extractAssistantFinalJson(obj)).toBe(obj);
  });

  test("(extra) no opening brace -> returns raw", () => {
    const raw = "assistantfinal no json here";
    expect(extractAssistantFinalJson(raw)).toBe(raw);
  });
});

describe("TCH.2 pickPreviousStage", () => {
  test("(a) ['a','b','c'],'c' -> 'b'", () => {
    expect(pickPreviousStage(["a", "b", "c"], "c")).toBe("b");
  });

  test("(b) ['a','b'],'a' -> null (idx 0)", () => {
    expect(pickPreviousStage(["a", "b"], "a")).toBeNull();
  });

  test("(c) currentStage not found -> null", () => {
    expect(pickPreviousStage(["a", "b", "c"], "z")).toBeNull();
  });

  test("(d) empty array -> null", () => {
    expect(pickPreviousStage([], "a")).toBeNull();
  });
});

describe("TCH.3 buildUpLifeAspirationReport", () => {
  test("(a) string answer", async () => {
    const data = [{ questions: " Goal ", answer: " be happy " }];
    const result = await buildUpLifeAspirationReport(data, "LifeForm");
    expect(result).toContain("LifeForm");
    expect(result).toContain(JSON.stringify(["Goal: be happy"]));
  });

  test("(b) array answer", async () => {
    const data = [{ questions: "Hobbies", answer: ["reading", "coding"] }];
    const result = await buildUpLifeAspirationReport(data, "HobbyForm");
    expect(result).toContain("HobbyForm");
    expect(result).toContain(
      JSON.stringify([`Hobbies: ${JSON.stringify(["reading", "coding"])}`])
    );
  });

  test("(c) mixed/empty answers", async () => {
    const data = [
      { questions: "A", answer: "x" },
      { questions: "B", answer: [] }, // empty array -> skipped
      { questions: "C", answer: ["y"] },
    ];
    const result = await buildUpLifeAspirationReport(data, "MixedForm");
    expect(result).toContain("MixedForm");
    expect(result).toContain(
      JSON.stringify(["A: x", `C: ${JSON.stringify(["y"])}`])
    );

    const emptyResult = await buildUpLifeAspirationReport([], "EmptyForm");
    expect(emptyResult).toContain("EmptyForm");
    expect(emptyResult).toContain(JSON.stringify([]));
  });
});

describe("TCH.4 shouldStartPod", () => {
  test("pendingCount 0 -> false", () => {
    expect(
      shouldStartPod({ pendingCount: 0, oldestAgeMin: 99, minJobs: 20, flushWaitMinutes: 15 })
    ).toBe(false);
  });

  test("below both thresholds -> false", () => {
    expect(
      shouldStartPod({ pendingCount: 5, oldestAgeMin: 2, minJobs: 20, flushWaitMinutes: 15 })
    ).toBe(false);
  });

  test("flush due by age -> true", () => {
    expect(
      shouldStartPod({ pendingCount: 5, oldestAgeMin: 20, minJobs: 20, flushWaitMinutes: 15 })
    ).toBe(true);
  });

  test("reached min jobs -> true", () => {
    expect(
      shouldStartPod({ pendingCount: 25, oldestAgeMin: 1, minJobs: 20, flushWaitMinutes: 15 })
    ).toBe(true);
  });
});
