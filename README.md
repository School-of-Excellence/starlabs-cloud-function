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

### 2. Deploy Function

```bash
firebase deploy --only functions:<FunctionName>
```

### 3. Push Code

After deployment, commit and push your changes:

```bash
git add .
git commit -m "your message"
git push origin development
```