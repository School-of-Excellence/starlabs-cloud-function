const fs = require("fs");
const path = require("path");
const process = require("process");

// ─────────────────────────────────────────────
// Firebase Functions Loop Detector (Pre-Deploy)
// Exit code 1 = loop detected → block deploy
// Exit code 0 = safe to deploy
// ─────────────────────────────────────────────

function removeComments(code) {
  code = code.replace(/\/\/.*$/gm, "");
  code = code.replace(/\/\*[\s\S]*?\*\//g, "");
  return code;
}

// ─── Parse index.js ───
function parseIndexFile(indexPath) {
  let content = fs.readFileSync(indexPath, "utf8");
  content = removeComments(content);

  const requires = {};
  const requireRegex =
    /const\s+(\w+)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  while ((match = requireRegex.exec(content)) !== null) {
    requires[match[1]] = match[2];
  }

  const functions = [];
  const exportRegex = /exports\.(\w+)\s*=\s*(\w+)\.(\w+)/g;
  while ((match = exportRegex.exec(content)) !== null) {
    functions.push({
      exportName: match[1],
      moduleName: match[2],
      functionName: match[3],
    });
  }

  return { requires, functions };
}

// ─── Read component files ───
function readComponentFiles(requires, indexDir) {
  const filesContent = {};
  const uniquePaths = new Set(Object.values(requires));

  uniquePaths.forEach((requirePath) => {
    const filePath = path.resolve(indexDir, requirePath + ".js");
    if (fs.existsSync(filePath)) {
      let content = fs.readFileSync(filePath, "utf8");
      content = removeComments(content);
      filesContent[requirePath] = { path: filePath, content };
    } else {
      filesContent[requirePath] = null;
    }
  });

  return filesContent;
}

// ─── Extract full function body (brace-matched, string-aware) ───
function extractFunctionBody(content, functionName) {
  const patterns = [
    `exports.${functionName}`,
    `const ${functionName}`,
    `module.exports.${functionName}`,
  ];

  let start = -1;
  for (const p of patterns) {
    start = content.indexOf(p);
    if (start !== -1) break;
  }
  if (start === -1) return null;

  // Find the arrow function or function body opening brace
  // Skip past the trigger path string like "collection/{docId}"
  // Look for => { or function() { pattern
  const afterStart = content.substring(start);
  const arrowMatch = afterStart.match(/=>\s*\{/);
  const funcMatch = afterStart.match(/function\s*\([^)]*\)\s*\{/);

  let firstBrace;
  if (arrowMatch && funcMatch) {
    // Use whichever comes first
    const arrowIdx = arrowMatch.index + arrowMatch[0].length - 1;
    const funcIdx = funcMatch.index + funcMatch[0].length - 1;
    firstBrace = start + Math.min(arrowIdx, funcIdx);
  } else if (arrowMatch) {
    firstBrace = start + arrowMatch.index + arrowMatch[0].length - 1;
  } else if (funcMatch) {
    firstBrace = start + funcMatch.index + funcMatch[0].length - 1;
  } else {
    return null;
  }

  // Brace-match to find the full function body, skipping strings
  let depth = 0;
  let end = firstBrace;
  let inString = false;
  let stringChar = null;

  for (let i = firstBrace; i < content.length; i++) {
    const ch = content[i];
    const prev = i > 0 ? content[i - 1] : "";

    if (inString) {
      if (ch === stringChar && prev !== "\\") {
        inString = false;
        stringChar = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") depth--;

    if (depth === 0) {
      end = i + 1;
      break;
    }
  }

  return {
    code: content.substring(start, end),
    startIndex: start,
  };
}

// ─── Detect trigger type and path ───
function detectTrigger(functionBody) {
  // onDocumentWritten("collection/{docId}", handler)
  // onDocumentUpdated("collection/{docId}", handler)
  // .document("collection/{docId}").onUpdate(handler)
  // .document("collection/{docId}").onWrite(handler)

  const triggerPatterns = [
    {
      regex: /onDocumentWritten\s*\(\s*["']([^"']+)["']/,
      type: "onDocumentWritten",
    },
    {
      regex: /onDocumentUpdated\s*\(\s*["']([^"']+)["']/,
      type: "onDocumentUpdated",
    },
    {
      regex: /\.document\s*\(\s*["']([^"']+)["']\s*\)\s*\.onWrite/,
      type: "onWrite",
    },
    {
      regex: /\.document\s*\(\s*["']([^"']+)["']\s*\)\s*\.onUpdate/,
      type: "onUpdate",
    },
  ];

  for (const { regex, type } of triggerPatterns) {
    const match = functionBody.match(regex);
    if (match) {
      const fullPath = match[1]; // e.g. "atc_alpha/{atcalphaid}"
      const collection = fullPath.split("/")[0]; // e.g. "atc_alpha"
      return { type, fullPath, collection };
    }
  }

  return null;
}

// ─── Detect writes back to the trigger ───
function detectWritesBackToTrigger(functionCode, trigger) {
  const writes = [];

  // Pattern 1: snapshot.data.after.ref.update / .set
  // This ALWAYS writes to the triggering document
  const selfRefPatterns = [
    /((snapshot|change|event)\s*\.?\s*data\s*\.?\s*after\s*\.?\s*ref\s*\.\s*(update|set))\s*\(/g,
    /((change)\s*\.?\s*after\s*\.?\s*ref\s*\.\s*(update|set))\s*\(/g,
  ];

  for (const regex of selfRefPatterns) {
    let match;
    while ((match = regex.exec(functionCode)) !== null) {
      writes.push({
        type: "self_ref_write",
        method: match[3],
        index: match.index,
        text: match[0].trim(),
        description: `Writes back to triggering document via .after.ref.${match[3]}()`,
      });
    }
  }

  // Pattern 2: .collection("same_collection").doc(...).update/.set
  const collectionWriteRegex = new RegExp(
    `\\.collection\\s*\\(\\s*["']${escapeRegex(trigger.collection)}["']\\s*\\)` +
      `[\\s\\S]{0,200}?\\.(update|set)\\s*\\(`,
    "g"
  );

  let match;
  while ((match = collectionWriteRegex.exec(functionCode)) !== null) {
    writes.push({
      type: "collection_write",
      method: match[1],
      index: match.index,
      text: match[0].substring(0, 80).trim(),
      description: `Writes to collection "${trigger.collection}" via .${match[1]}()`,
    });
  }

  // Pattern 3: batch.update / batch.set targeting same collection
  const batchWriteRegex = new RegExp(
    `(batch|writeBatch)\\s*\\.[\\s\\S]{0,300}?` +
      `collection\\s*\\(\\s*["']${escapeRegex(trigger.collection)}["']\\s*\\)` +
      `[\\s\\S]{0,200}?\\.(update|set)\\s*\\(`,
    "g"
  );

  while ((match = batchWriteRegex.exec(functionCode)) !== null) {
    writes.push({
      type: "batch_write",
      method: match[2],
      index: match.index,
      text: match[0].substring(0, 80).trim(),
      description: `Batch write to collection "${trigger.collection}"`,
    });
  }

  // Pattern 4: transaction.update / transaction.set targeting same collection
  const txWriteRegex = new RegExp(
    `(transaction|tx|t)\\s*\\.[\\s\\S]{0,300}?` +
      `collection\\s*\\(\\s*["']${escapeRegex(trigger.collection)}["']\\s*\\)` +
      `[\\s\\S]{0,200}?\\.(update|set)\\s*\\(`,
    "g"
  );

  while ((match = txWriteRegex.exec(functionCode)) !== null) {
    writes.push({
      type: "transaction_write",
      method: match[2],
      index: match.index,
      text: match[0].substring(0, 80).trim(),
      description: `Transaction write to collection "${trigger.collection}"`,
    });
  }

  return writes;
}

// ─── Detect loop guards ───
function hasLoopGuard(functionCode) {
  const guards = [];

  // Guard 1: Explicit @loop-safe annotation
  // Developer can add: // @loop-safe: checked field diff
  if (functionCode.includes("@loop-safe")) {
    guards.push("@loop-safe annotation");
  }

  // Guard 2: JSON.stringify comparison of before/after
  if (
    functionCode.match(
      /JSON\.stringify\s*\([^)]*before[^)]*\)\s*===\s*JSON\.stringify\s*\([^)]*after/
    ) ||
    functionCode.match(
      /JSON\.stringify\s*\([^)]*after[^)]*\)\s*===\s*JSON\.stringify\s*\([^)]*before/
    )
  ) {
    guards.push("JSON.stringify diff check");
  }

  // Guard 3: Field-level comparison with early return
  // e.g., if (before.field === after.field) return;
  // e.g., if (oldData.x === newData.x) return null;
  const fieldCompareReturn =
    /if\s*\([^)]*(?:before|old\w*)\s*(?:\.\w+|\[['"][^'"]+['"]\])\s*===\s*[^)]*(?:after|new\w*)[^)]*\)\s*(?:\{?\s*return\b|\breturn\b)/;
  if (fieldCompareReturn.test(functionCode)) {
    guards.push("Field-level diff with early return");
  }

  // Guard 4: Deep/shallow equality check
  if (
    functionCode.match(/isEqual\s*\(/) ||
    functionCode.match(/lodash.*isEqual/) ||
    functionCode.match(/deepEqual\s*\(/)
  ) {
    guards.push("Deep equality check");
  }

  // Guard 5: Timestamp guard (_lastFunctionWrite pattern)
  if (
    functionCode.match(
      /(_lastFunctionWrite|_updatedByFunction|_functionTimestamp|lastModifiedBy)/
    )
  ) {
    guards.push("Timestamp/marker guard");
  }

  // Guard 6: "updatedBy" or "source" field check
  if (functionCode.match(/(updatedBy|modifiedBy|source)\s*===\s*["']function/)) {
    guards.push("Source/updatedBy guard");
  }

  // Guard 7: Generic before vs after comparison with return
  // Catches: if(oldAuthorIds === newAuthorIds) return  (but this is weak for arrays)
  // Better: if(JSON.stringify(old) === JSON.stringify(new)) return
  const genericDiffReturn =
    /if\s*\(\s*(?:JSON\.stringify\s*\()?\s*(?:old|before|prev)\w*\s*(?:\)?\s*===\s*(?:JSON\.stringify\s*\()?\s*(?:new|after|current)\w*)\s*\)?\s*\)\s*(?:\{?\s*return\b)/;
  if (genericDiffReturn.test(functionCode)) {
    guards.push("Generic before/after diff guard");
  }

  return guards;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getLineNumber(content, index) {
  return content.substring(0, index).split("\n").length;
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
function main() {
  const indexPath = process.argv[2] || "./index.js";
  const indexDir = path.dirname(path.resolve(indexPath));

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Firebase Loop Detector — Pre-Deploy Gate");
  console.log(`${"=".repeat(60)}\n`);

  // Parse
  const { requires, functions } = parseIndexFile(indexPath);
  const filesContent = readComponentFiles(requires, indexDir);

  console.log(
    `Scanned ${functions.length} functions across ${Object.keys(requires).length} modules\n`
  );

  const loopRisks = []; // Functions that WILL loop (block deploy)
  const warnings = []; // Functions that MIGHT loop (warn only)
  const safe = []; // Functions that are safe

  functions.forEach((func) => {
    const requirePath = requires[func.moduleName];
    if (!requirePath) return;

    const fileData = filesContent[requirePath];
    if (!fileData) return;

    // Extract full function body
    const extracted = extractFunctionBody(fileData.content, func.functionName);
    if (!extracted) return;

    const functionCode = extracted.code;

    // Check if it's an onUpdate/onWrite trigger
    const trigger = detectTrigger(functionCode);
    if (!trigger) return; // Not a write/update trigger — no loop risk

    // Detect writes back to trigger
    const writesBack = detectWritesBackToTrigger(functionCode, trigger);
    if (writesBack.length === 0) {
      safe.push({ func, trigger, reason: "No writes to trigger collection" });
      return;
    }

    // Check for loop guards
    const guards = hasLoopGuard(functionCode);

    if (guards.length === 0) {
      // NO guard + writes back = WILL LOOP → block deploy
      loopRisks.push({
        func,
        trigger,
        writes: writesBack,
        file: fileData.path,
        functionCode,
      });
    } else {
      // Has a guard but still writes back — warn but allow
      warnings.push({
        func,
        trigger,
        writes: writesBack,
        guards,
        file: fileData.path,
      });
    }
  });

  // ─── Report ───

  if (safe.length > 0) {
    console.log(`✅ Safe functions (${safe.length}):`);
    safe.forEach((s) => {
      console.log(`   ${s.func.exportName} — ${s.reason}`);
    });
    console.log();
  }

  if (warnings.length > 0) {
    console.log(`⚠️  Warnings (${warnings.length}) — has guard but review recommended:`);
    warnings.forEach((w) => {
      console.log(`   ${w.func.exportName}`);
      console.log(`     Trigger: ${w.trigger.type}("${w.trigger.fullPath}")`);
      console.log(`     Guards:  ${w.guards.join(", ")}`);
      w.writes.forEach((wr) => {
        console.log(`     Write:   ${wr.description}`);
      });
    });
    console.log();
  }

  if (loopRisks.length > 0) {
    console.log(
      `\n${"!".repeat(60)}`
    );
    console.log(`  ❌ DEPLOY BLOCKED — ${loopRisks.length} function(s) will cause infinite loops`);
    console.log(`${"!".repeat(60)}\n`);

    loopRisks.forEach((risk, i) => {
      console.log(`── Function ${i + 1}: ${risk.func.exportName} ──`);
      console.log(`   File:      ${risk.file}`);
      console.log(
        `   Trigger:   ${risk.trigger.type}("${risk.trigger.fullPath}")`
      );
      console.log(`   Problem:   Writes back to "${risk.trigger.collection}" with NO loop guard`);
      risk.writes.forEach((w) => {
        console.log(`   Write:     ${w.description}`);
      });
      console.log();
      console.log(`   ┌─ How to fix ─────────────────────────────────────────`);
      console.log(`   │ Option 1: Add a diff guard at the top of the function:`);
      console.log(`   │`);
      console.log(`   │   const before = snapshot.data.before.data();`);
      console.log(`   │   const after = snapshot.data.after.data();`);
      console.log(`   │   if (JSON.stringify(before.fieldYouWatch) ===`);
      console.log(`   │       JSON.stringify(after.fieldYouWatch)) return null;`);
      console.log(`   │`);
      console.log(`   │ Option 2: Add // @loop-safe: <reason> to suppress`);
      console.log(`   └──────────────────────────────────────────────────────`);
      console.log();
    });

    // EXIT WITH ERROR — blocks deploy pipeline
    console.log("Deploy aborted. Fix the issues above and retry.\n");
    process.exit(1);
  } else {
    console.log(`\n✅ All functions passed loop detection. Safe to deploy.\n`);
    process.exit(0);
  }
}

try {
  main();
} catch (error) {
  console.error("\n❌ Error running loop detector:", error.message);
  process.exit(2);
}