# Dockerfile — ATC drain worker (Cloud Run Job: atc-drain-worker).
#
# NOT used by `firebase deploy` (Cloud Functions builds with its own buildpack and
# ignores Dockerfiles; also excluded via firebase.json "ignore"). USED ONLY by:
#   gcloud run jobs deploy atc-drain-worker --source . ...
#
# Why a Dockerfile: the buildpack image wraps the app in a launcher entrypoint
# (/cnb/lifecycle/launcher) that sets up PATH/runtime env. Overriding the job's
# --command=node bypassed that launcher, so `node` couldn't exec ("exec likely
# failed"). A standard node image puts `node` on PATH directly — no launcher needed.
FROM node:22-slim
WORKDIR /app

# Deterministic prod deps. drain.js → components/pod-execution-pipeline/pod_jobs →
# queue-aiatc-generation-pipeline/se_atc_failure_classifier need firebase-admin;
# install the full set so every transitive require resolves.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (components/, worker/, queue-aiatc-generation-pipeline/, …).
# node_modules/.git are excluded via .dockerignore so the npm ci layer is kept.
COPY . .

# The drain loop claims pending jobs, runs inference, then exits (Cloud Run Job
# runs to completion). The deploy also sets --command=node --args=worker/drain.js;
# this CMD is the same, for `docker run` parity.
CMD ["node", "worker/drain.js"]
