const http = require('http');

const host = '0.0.0.0'
const port = 3000

const server = http.createServer((request, response) => {
  response.writeHead(200, {"Content-Type": "text/plain"});
  response.write("Hello World!");
  response.end();
});

server.listen(port, host, (error) => {
  if (error) {
    return console.log('Error occurred : ', error );
  }

  console.log('server is listening on ' + host + ':'+ port);
});
