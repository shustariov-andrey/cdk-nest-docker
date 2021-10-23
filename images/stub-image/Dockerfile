FROM node:14.16.1-alpine3.13

USER node

RUN mkdir -p /home/node/app
WORKDIR /home/node/app
COPY --chown=node:node index.js ./

EXPOSE 3000

CMD ["node", "index.js"]
