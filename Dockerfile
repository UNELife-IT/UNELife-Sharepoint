FROM caddy:2.8-alpine
COPY index.html /srv/index.html
COPY articles /srv/articles
CMD ["sh", "-c", "caddy file-server --root /srv --listen :${PORT:-8080}"]
