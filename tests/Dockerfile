FROM node:22-trixie-slim
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl clangd libglib2.0-bin xvfb xauth dbus-x11 \
 && curl -fL -o /tmp/app.deb "https://downloads.eolymp.com/code/EolympCode-linux-$([ "$TARGETARCH" = amd64 ] && echo x64 || echo arm64).deb" \
 && apt-get install -y --no-install-recommends /tmp/app.deb \
 && rm -rf /tmp/app.deb /var/lib/apt/lists/*
USER node
RUN mkdir /tmp/eolymp-code-test-tools
VOLUME /tmp/eolymp-code-test-tools
WORKDIR /code/tests
CMD ["xvfb-run", "--auto-servernum", "npm", "test"]
