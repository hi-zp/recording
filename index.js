const express = require('express');
const https = require('https');
const fs = require('fs');

const app = express();

const options = {
  key: fs.readFileSync('./server.key'), // 替换为您的私钥文件路径
  cert: fs.readFileSync('./server.crt') // 替换为您的证书文件路径
};

app.use(express.static('public'));

https.createServer(options, app).listen(4001, () => {
  console.log('HTTPS server is running');
});