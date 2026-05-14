FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive

# Add here whatever dev-tools you need
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    openssh-client \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Ubuntu 26.04 ships with a default 'ubuntu' user at 1000:1000 — reuse it
RUN usermod -l opencode ubuntu && \
    groupmod -n opencode ubuntu && \
    usermod -d /home/opencode -m opencode

RUN mkdir -p /home/opencode/.config/opencode \
             /home/opencode/.local/share/opencode \
             /home/opencode/workspace && \
    chown -R opencode:opencode /home/opencode

USER opencode
WORKDIR /home/opencode

RUN curl -fsSL https://opencode.ai/install | bash

ENV PATH="/home/opencode/.opencode/bin:$PATH"
ENV HOME=/home/opencode

WORKDIR /home/opencode/workspace
ENTRYPOINT ["opencode"]