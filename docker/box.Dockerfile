FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    NVM_DIR=/opt/nvm \
    NODE_VERSION=22

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget git git-lfs openssh-client sudo bash-completion \
    build-essential pkg-config python3 python3-pip python3-venv python-is-python3 \
    ripgrep fd-find jq unzip zip tar gzip xz-utils nano vim less htop procps \
    net-tools iproute2 iputils-ping dnsutils locales tzdata \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p "$NVM_DIR" \
    && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash \
    && . "$NVM_DIR/nvm.sh" \
    && nvm install "$NODE_VERSION" \
    && nvm alias default "$NODE_VERSION" \
    && nvm use default \
    && npm config set fund false \
    && npm config set audit false \
    && npm install -g @mariozechner/pi-coding-agent --no-audit --no-fund \
    && ln -sf "$NVM_DIR/versions/node/$(. "$NVM_DIR/nvm.sh" && nvm version)/bin/node" /usr/local/bin/node \
    && ln -sf "$NVM_DIR/versions/node/$(. "$NVM_DIR/nvm.sh" && nvm version)/bin/npm" /usr/local/bin/npm \
    && ln -sf "$NVM_DIR/versions/node/$(. "$NVM_DIR/nvm.sh" && nvm version)/bin/npx" /usr/local/bin/npx \
    && ln -sf "$NVM_DIR/versions/node/$(. "$NVM_DIR/nvm.sh" && nvm version)/bin/pi" /usr/local/bin/pi

RUN curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone --prefix=/usr/local

ENV PATH=/usr/local/bin:$PATH \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8

RUN mkdir -p /workspace /root/.pi/agent && chmod 777 /workspace
WORKDIR /workspace

CMD ["bash", "-lc", "sleep infinity"]
