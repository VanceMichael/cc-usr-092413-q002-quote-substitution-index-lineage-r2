FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test
COPY contracts ./contracts
COPY fixtures ./fixtures
RUN npm test
VOLUME ["/data"]
EXPOSE 8080
CMD ["npm", "start"]
