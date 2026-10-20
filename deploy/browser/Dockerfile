# Headless browser sidecar for the Compose `browser` profile (topology D). Owner: S22.
# The Playwright base image ships the browsers; the `playwright` package comes from the committed
# lockfile (npm ci, integrity-checked), so nothing is fetched from a registry when the container
# starts (issue #298, DEP-8). Keep the package version equal to the base image's version.
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:7852dc5a7d72f5fe458a597d690f6c42fbc8e9e26ddfa95f8e6ef552558d9bbf
WORKDIR /opt/psyche-browser
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
USER pwuser
# Loopback only: the Gateway's browser driver connects on the host network (security §6).
ENTRYPOINT ["/opt/psyche-browser/node_modules/.bin/playwright", "run-server", "--host", "127.0.0.1", "--port", "3000"]
