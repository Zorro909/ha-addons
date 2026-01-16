ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js, npm, and dependencies
RUN apk add --no-cache \
    nodejs \
    npm \
    curl \
    bash \
    jq \
    bc \
    mosquitto-clients

# Install Foundry (cast CLI) - use bash explicitly for installer
ENV FOUNDRY_DIR=/root/.foundry
ENV PATH="${FOUNDRY_DIR}/bin:${PATH}"
RUN curl -L https://foundry.paradigm.xyz | bash -s -- -y && \
    foundryup && \
    ln -s /root/.foundry/bin/cast /usr/local/bin/cast

# Copy application files
WORKDIR /app
COPY rootfs/app/ .
# Install all dependencies for type checking
RUN npm install && \
    npx tsc --noEmit && \
    npm prune --production

# Copy scripts
COPY rootfs/usr /usr
COPY run.sh /run.sh
RUN chmod a+x /run.sh /usr/local/bin/*.sh 2>/dev/null || true

CMD [ "/run.sh" ]
