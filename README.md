# Cloud Functions Setup

## Prerequisites

Install Firebase CLI:

```bash
npm install -g firebase-tools
```

## Deployment

### 1. Select Project

```bash
firebase use <alias>
```

**Available aliases:**
- `default` - Test project
- `production` - Production project

### 2. Run Loop Detector

Navigate to the `functions` directory and run the loop detector to check for infinite loop risks:

```bash
cd functions
node loopDetector.js ./index.js
```

- If the check **passes**, you'll see: `✅ All functions passed loop detection. Safe to deploy.`
- If the check **fails**, it will show which function has the issue and how to fix it. **Do not deploy until the issue is resolved.**

### 3. Deploy Function

From the `functions` directory, run the loop detector and deploy in a single command — deployment will only proceed if the check passes:

```bash
node loopDetector.js ./index.js && firebase deploy --only functions:<FunctionName>
```

> **Note:** If your function uses `onDocumentWritten` or `onDocumentUpdated` and writes back to the same collection, you must add a diff guard to prevent infinite loops. Example:
> ```javascript
> if (JSON.stringify(oldAuthorIds) === JSON.stringify(newAuthorIds)) {
>   return null;
> }
> ```
> Alternatively, add `// @loop-safe: <reason>` inside the function to suppress the warning (only if you're sure it's safe).

### 4. Push Code

After deployment, commit and push your changes:

```bash
git add .
git commit -m "your message"
git push origin development
```