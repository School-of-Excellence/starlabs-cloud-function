/* global describe, test, expect, jest, __dirname */
// All Firebase packages are replaced by in-memory mocks — nothing here touches a real project.
const { installFirebaseMocks } = require("./helpers/fake-firestore");
installFirebaseMocks();
const fs = require("fs");
const path = require("path");
const idx = require("../../../components/participant360");
const { envelope } = require("../../../components/participant360/envelope");

const EXPECTED = ["purchase", "finance", "activeProduct", "forms", "appointment", "queue", "events", "communication", "recommendation", "content", "mode", "roles", "videoAsk", "evolutionMapping", "systemBilling", "profileAuthentication"];

describe("participant360 registry", () => {
  test("never loads a real Firebase package: every firebase require resolves to the in-memory mock", () => {
    expect(require("firebase-admin").__fake).toBe(true);
    expect(jest.isMockFunction(require("firebase-admin/firestore").getFirestore)).toBe(true);
    expect(jest.isMockFunction(require("firebase-functions/v2/https").onRequest)).toBe(true);
    expect(jest.isMockFunction(require("firebase-functions/params").defineSecret)).toBe(true);
    expect(require("../../../components/participant360/collection").admin.__fake).toBe(true);
  });

  test("16 tools, name == filename, each has description/input_schema/sources/handler", () => {
    expect(idx.TOOLS.map((t) => t.name)).toEqual(EXPECTED);
    const files = fs.readdirSync(path.join(__dirname, "../../../components/participant360/tools")).map((f) => f.replace(/\.js$/, "")).sort();
    expect(files).toEqual([...EXPECTED].sort());
    for (const t of idx.TOOLS) {
      expect(typeof t.description).toBe("string");
      expect(t.input_schema.required).toEqual(["profileid"]);
      expect(Array.isArray(t.sources) && t.sources.length > 0).toBe(true);
      expect(typeof t.handler).toBe("function");
      expect(typeof t.project).toBe("function");
    }
  });

  test("toolDefinitions() is Messages-API shaped and includes resolve", () => {
    const defs = idx.toolDefinitions();
    expect(defs.length).toBe(17);
    expect(defs[0].name).toBe("resolve");
    for (const d of defs) expect(Object.keys(d).sort()).toEqual(["description", "input_schema", "name"]);
  });

  test("routerToolDefinition(): one tool, tool enum of 16, participantid required, filters merged", () => {
    const d = idx.routerToolDefinition();
    expect(d.name).toBe("participant360");
    expect(typeof d.description).toBe("string");
    expect(d.input_schema.type).toBe("object");
    expect(d.input_schema.required).toEqual(["tool", "participantid"]);
    expect(d.input_schema.additionalProperties).toBe(false);
    expect(d.input_schema.properties.tool.enum).toEqual(EXPECTED);
    expect(Object.keys(d.input_schema.properties)).toEqual(expect.arrayContaining(["tool", "participantid", "limit", "since", "status", "kind", "channel", "type", "includeDenied"]));
    for (const p of Object.values(d.input_schema.properties)) expect(typeof p.description).toBe("string");
  });

  test("runRouterTool(): maps participantid -> profileid and validates tool", async () => {
    expect(await idx.runRouterTool({})).toMatchObject({ ok: false, error: "bad_request" });
    expect(await idx.runRouterTool({ tool: "nope", participantid: "P1" })).toMatchObject({ ok: false, error: "unknown_tool" });
    expect(await idx.runRouterTool({ tool: "purchase" })).toMatchObject({ ok: false, error: "bad_request" });
  });

  test("catalogue lists filters per tool", () => {
    const c = idx.catalogue();
    expect(c.tools.find((t) => t.name === "forms").filters).toEqual(["status"]);
    expect(c.tools.find((t) => t.name === "purchase").filters).toEqual([]);
  });

  test("runTool: unknown tool / missing profileid never throw", async () => {
    expect(await idx.runTool("purchse", { profileid: "x" })).toMatchObject({ ok: false, error: "unknown_tool" });
    expect((await idx.runTool("purchse", { profileid: "x" })).tools).toEqual(EXPECTED);
    expect(await idx.runTool("purchase", {})).toMatchObject({ ok: false, error: "bad_request" });
  });

  test("assertShape enforces the locked envelope", () => {
    expect(() => idx.assertShape(envelope({ summary: { headline: "x" }, counts: { total: 0 }, items: [] }))).not.toThrow();
    expect(() => idx.assertShape({ ok: true, data: { summary: {}, counts: { total: 0, returned: 0 }, items: [] } })).toThrow(/headline/);
    expect(() => idx.assertShape({ ok: true, data: { summary: { headline: "x" }, counts: { total: 1, returned: 2 }, items: [{}] } })).toThrow(/returned/);
  });

  test("structural fence: no firestore-atc handle anywhere in the module", () => {
    const dir = path.join(__dirname, "../../../components/participant360");
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(dir)) {
      const src = fs.readFileSync(f, "utf8");
      // A handle = opening the ATC database or naming an atc_* collection as a registry entry.
      // (The string "atc_alpha" inside HIDDEN_KEYS is the strip-list, not a handle.)
      const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      const hasAtcHandle = /getFirestore\(\s*["']firestore-atc|db:\s*["']atc["']|collection\(\s*["']atc_|name:\s*["']atc_/.test(code);
      expect({ file: path.basename(f), hasAtcHandle }).toEqual({ file: path.basename(f), hasAtcHandle: false });
    }
  });

  test("toToolResult marks failures is_error", () => {
    expect(idx.toToolResult("tu_1", { ok: false, error: "internal" })).toMatchObject({ type: "tool_result", tool_use_id: "tu_1", is_error: true });
    expect(idx.toToolResult("tu_1", { ok: true, result: { a: 1 } })).toEqual({ type: "tool_result", tool_use_id: "tu_1", content: '{"a":1}' });
  });
});
