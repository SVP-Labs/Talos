FROM alpine:3.20.3
RUN apk add --no-cache bash=5.2.26-r0
COPY scripts/greet.sh /usr/local/bin/greet
USER 1000
ENTRYPOINT ["/usr/local/bin/greet"]
