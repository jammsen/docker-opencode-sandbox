FROM ubuntu:26.04@sha256:3131b4cc82a783df6c9df078f86e01819a13594b865c2cad47bd1bca2b7063bb

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Europe/Berlin \
    PUID=1000 \
    PGID=1000 \
    # Tool selection — order defines menu order, first entry is the default
    TOOLS=opencode,omp \
    # Pin tool data dirs explicitly so subprocesses find language toolchains reliably
    CARGO_HOME=/home/agent/.cargo \
    RUSTUP_HOME=/home/agent/.rustup \
    # Absolute path so Playwright finds its browsers even when opencode redirects HOME at runtime
    PLAYWRIGHT_BROWSERS_PATH=/home/agent/.cache/ms-playwright \
    # All user tool bins in PATH — inherited by every subprocess after exec gosu
    PATH="/home/agent/.local/bin:/home/agent/.cargo/bin:/home/agent/.opencode/bin:${PATH}"


# Optional apt mirror (full URL incl. /ubuntu/, e.g. https://mirror.netcologne.de/ubuntu/);
# empty = stock archive/security.ubuntu.com. Set via .env, see .env.example.
ARG APT_MIRROR=""
# ForceIPv4: apt's IPv6 attempts stall behind Docker Desktop/WSL2 NAT. docker-clean would empty
# the .deb cache after every install, defeating the BuildKit cache mounts on the RUNs below.
RUN printf 'Acquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/99force-ipv4 \
    && rm -f /etc/apt/apt.conf.d/docker-clean \
    && printf 'Binary::apt::APT::Keep-Downloaded-Packages "true";\n' > /etc/apt/apt.conf.d/99keep-debs

# Bootstrap TLS trust from the stock (GPG-verified, http) archive BEFORE the mirror switch, so
# APT_MIRROR may be https — only this one package ever rides plain http (apt http-path bugs like
# CVE-2019-3462 are the threat model; everything after goes TLS).
# hadolint ignore=DL3008,DL3009
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends --no-install-suggests ca-certificates

RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i -E "s#https?://(archive|security)\.ubuntu\.com/ubuntu/?#$APT_MIRROR#g" /etc/apt/sources.list.d/ubuntu.sources; \
    fi

# Install basic tools
# hadolint ignore=DL3008,DL3009 # Base-Image Ubuntu 26.04 is already pinned
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends --no-install-suggests \
    build-essential \
    ca-certificates \
    curl \
    dnsutils \
    git \
    git-lfs \
    gosu \
    iproute2 \
    iputils-ping \
    jq \
    lsof \
    netcat-openbsd \
    openssh-client \
    openssl \
    pkg-config \
    postgresql-client \
    procps \
    ripgrep \
    tmux \
    sqlite3 \
    tree \
    tzdata \
    unzip \
    wget \
    zip \
    && apt-get autoremove -y \
# clean/lists-rm contradict the apt cache mounts (both dirs live outside the image, shared across builds)
#   && apt-get clean \
#   && rm -rf /var/lib/apt/lists/* \
    && rm -rf /tmp/* /var/tmp/*

# Node.js — system-wide, available for workspace projects
# hadolint ignore=DL3008,DL3009 # Base-Image Ubuntu 26.04 is already pinned
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends --no-install-suggests nodejs npm \
    && apt-get autoremove -y \
# clean/lists-rm contradict the apt cache mounts (both dirs live outside the image, shared across builds)
#   && apt-get clean \
#   && rm -rf /var/lib/apt/lists/* \
    && rm -rf /tmp/* /var/tmp/*

# WeTTY — browser-based terminal served on port 1111
# mcp-searxng — pre-installed so OMP (which eagerly starts MCP servers at launch)
#               doesn't time out waiting for npx to download it on first use
RUN npm install -g wetty@3.1.0 mcp-searxng@1.8.0

# yq (mikefarah, static Go binary) — the model-config wizard reads/writes config/models/models.yml
# with it, and the entrypoint renders the tool configs from that file. Pinned + checksummed.
ARG YQ_VERSION=v4.53.3
RUN arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
         amd64) sha=fa52a4e758c63d38299163fbdd1edfb4c4963247918bf9c1c5d31d84789eded4 ;; \
         arm64) sha=578648e463a11c1b6db6010cbf41eafed6bee79466fcffa1bb446672cf7945ea ;; \
         *) echo "unsupported arch $arch" && exit 1 ;; \
       esac \
    && curl -fsSL -o /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${arch}" \
    && echo "$sha  /usr/local/bin/yq" | sha256sum -c - \
    && chmod 755 /usr/local/bin/yq && yq --version

# Patch wetty's env.js which assumes "env (GNU coreutils)" version string.
# Ubuntu 26.04 ships uutils coreutils whose version output is "env (uutils coreutils) 0.8.0",
# causing an uncaughtException when the string split returns undefined.
# Returning 0 is safe: env version >=9 is only needed for the -S flag, which we never use.
RUN sed -i \
    '/resolve(parseInt(stdout\.split/s/.*/        resolve(0);/' \
    /usr/local/lib/node_modules/wetty/build/server/spawn/env.js \
    && grep -q 'resolve(0)' /usr/local/lib/node_modules/wetty/build/server/spawn/env.js \
    && echo 'env.js patched OK'

# Unit tests — each RUN below fails the build if its layer's code is broken.
COPY --chmod=644 tests/ /tests/

# Patch WeTTY — CSP frameSrc + upload overlay panel + OSC 52 clipboard + font/theme defaults.
# Scripts live in patches/ and are removed after use (not needed at runtime).
# wetty-theme must follow wetty-font: it would otherwise break that patch's anchor.
COPY --chmod=644 patches/ /tmp/patches/
RUN node /tmp/patches/wetty-csp.js && node /tmp/patches/wetty-html.js \
    && node /tmp/patches/wetty-clipboard.js && node /tmp/patches/wetty-font.js \
    && node /tmp/patches/wetty-theme.js \
    && rm -rf /tmp/patches && node /tests/test-wetty-clipboard.js

# Replace WeTTY's default favicon with our own console icon.
# Alternates live in assets/favicon-alternates/ for reference, not used at build time.
COPY --chmod=644 assets/favicon.ico /usr/local/lib/node_modules/wetty/build/client/favicon.ico

# Self-signed TLS cert for WeTTY — avoids browser HTTPS-upgrade blocking on HTTP
# Browsers show a one-time "proceed anyway" warning, then work fine.
RUN mkdir -p /etc/wetty \
    && openssl req -x509 -newkey rsa:4096 \
       -keyout /etc/wetty/key.pem \
       -out /etc/wetty/cert.pem \
       -days 3650 -nodes \
       -subj "/CN=agentic-harness-sandbox" \
    && chmod 644 /etc/wetty/key.pem /etc/wetty/cert.pem

# Chromium headless system libraries — required for Playwright
# hadolint ignore=DL3008,DL3009 # Base-Image Ubuntu 26.04 is already pinned
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends --no-install-suggests \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libatspi2.0-0t64 \
    libcairo2 \
    libcups2t64 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0t64 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && apt-get autoremove -y \
# clean/lists-rm contradict the apt cache mounts (both dirs live outside the image, shared across builds)
#   && apt-get clean \
#   && rm -rf /var/lib/apt/lists/* \
    && rm -rf /tmp/* /var/tmp/*

# Ubuntu 26.04 ships with a default 'ubuntu' user at 1000:1000 — reuse it
RUN usermod -l agent ubuntu && \
    groupmod -n agent ubuntu && \
    usermod -d /home/agent -m agent

RUN mkdir -p /home/agent/.config/opencode \
    /home/agent/.local/share/opencode \
    /home/agent/.omp/agent \
    /home/agent/.omp/logs \
    /home/agent/workspace && \
    chown -R agent:agent /home/agent

# Switch to agent user — HOME is now /home/agent, installs land in the right place
USER agent
WORKDIR /home/agent

# opencode
RUN curl -fsSL https://opencode.ai/install | bash

# omp
RUN curl -fsSL https://omp.sh/install | sh

# Rust — --no-modify-path because PATH is managed via ENV above
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path

# uv + Python
# ARG here (not at top) so changing PYTHON_VERSION only busts cache from this layer onward
ARG PYTHON_VERSION=3.13
ENV PYTHON_VERSION=${PYTHON_VERSION}
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && uv python install ${PYTHON_VERSION}

# Playwright — install Chromium browser binary at build time (system libs already installed above)
# --no-sandbox is required at runtime due to cap_drop: ALL — see AGENTS.md
RUN npx -y playwright install chromium

# claude — installs to ~/.local/bin/claude which is already on PATH via ENV above
RUN curl -fsSL https://claude.ai/install.sh | bash

# hadolint ignore=DL3002 # Entrypoint drops privileges to agent user
USER root
WORKDIR /

COPY --chmod=744 scripts/entrypoint.sh /
COPY --chmod=644 includes/ /includes/
COPY --chmod=755 scripts/agent-session.sh /agent-session.sh
COPY --chmod=644 config/tmux.conf /home/agent/.tmux.conf
COPY --chmod=644 scripts/upload-server.js /upload-server.js
COPY --chmod=755 scripts/upload-server/ /upload-server/
COPY --chmod=644 scripts/claude-shim.js /claude-shim.js
RUN SHIM_PATH=/claude-shim.js node /tests/test-claude-shim.js
# reasoning-normalizer.js is a server-side file (../server/scripts/), not part of this image.
# Its unit test (../server/tests/test-reasoning-normalizer.js) runs against the server repo instead.
COPY --chmod=755 scripts/agent-task.sh /usr/local/bin/agent-task
COPY --chmod=755 scripts/model-config.sh /usr/local/bin/model-config
COPY --chmod=755 scripts/render-models.sh /usr/local/bin/render-models
COPY --chmod=755 scripts/analyze-image.js /usr/local/bin/analyze-image

ENTRYPOINT ["./entrypoint.sh"]
