const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3307,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  // Enables secure SSL automatically when connecting to TiDB Cloud
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined
});

module.exports = pool;