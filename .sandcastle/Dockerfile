FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
  curl \
  git \
  jq \
  ripgrep \
  unzip \
  && rm -rf /var/lib/apt/lists/*

ENV BUN_INSTALL="/usr/local"
ENV PATH="/usr/local/bin:${PATH}"
RUN curl -fsSL https://bun.sh/install | bash

ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g $AGENT_GID node \
  && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

RUN bun install -g @openai/codex

RUN mkdir -p /home/agent/.bun /home/agent/.cache /home/agent/.npm /home/agent/.tmp \
  && chown -R $AGENT_UID:$AGENT_GID /home/agent/.bun /home/agent/.cache /home/agent/.npm /home/agent/.tmp

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent

ENV BUN_INSTALL="/home/agent/.bun"
ENV XDG_CACHE_HOME="/home/agent/.cache"
ENV npm_config_cache="/home/agent/.npm"
ENV npm_config_yes="true"
ENV TMPDIR="/home/agent/.tmp"
ENV PATH="/usr/local/bin:/home/agent/.bun/bin:${PATH}"

ENTRYPOINT ["sleep", "infinity"]
