require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors());
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 4000,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
  waitForConnections: true,
  connectionLimit: 10
});

// Health check route
app.get('/', (req, res) => {
  res.json({ status: 'SLPMS Backend API is running' });
});

// 1. Get all activities
app.get('/api/activities', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM activities ORDER BY id DESC');
    res.json(rows);
  } catch (err) {
    console.error('GET /api/activities error:', err);
    res.status(500).json({ error: 'Failed to fetch activities.' });
  }
});

// 2. Teacher publishes a new activity
app.post('/api/activities', async (req, res) => {
  const { title, max_score, deadline } = req.body;
  if (!title || !max_score || !deadline) {
    return res.status(400).json({ error: 'Title, max_score, and deadline are required.' });
  }

  try {
    const [result] = await pool.query(
      'INSERT INTO activities (title, max_score, deadline) VALUES (?, ?, ?)',
      [title.trim(), Number(max_score), deadline]
    );
    res.status(201).json({
      id: result.insertId,
      message: 'Activity published successfully.'
    });
  } catch (err) {
    console.error('POST /api/activities error:', err);
    res.status(500).json({ error: 'Failed to publish activity.' });
  }
});

// 3. Student submits an activity score (enforces max_score + single submission)
app.post('/api/submissions', async (req, res) => {
  const { student_name, activity_id, mode, raw_score } = req.body;

  if (!student_name || !activity_id || !mode || raw_score === undefined || raw_score === null) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const numericScore = Number(raw_score);
  if (Number.isNaN(numericScore) || numericScore < 0) {
    return res.status(400).json({ error: 'Score cannot be negative.' });
  }

  try {
    // Verify activity exists and check max_score
    const [activityRows] = await pool.query(
      'SELECT title, max_score, deadline FROM activities WHERE id = ?',
      [Number(activity_id)]
    );

    if (activityRows.length === 0) {
      return res.status(404).json({ error: 'Selected activity not found.' });
    }

    const activity = activityRows[0];
    const maxScore = Number(activity.max_score);

    if (numericScore > maxScore) {
      return res.status(400).json({
        error: `Error: Score (${numericScore}) cannot exceed the maximum score of ${maxScore} pts for "${activity.title}".`
      });
    }

    // Determine On-Time vs Late status based on deadline
    const now = new Date();
    const dueDate = new Date(activity.deadline);
    const status = now > dueDate ? 'Late' : 'On-Time';

    // Insert submission (UNIQUE constraint on student_name + activity_id blocks duplicates)
    await pool.query(
      `INSERT INTO submissions (student_name, activity_id, mode, raw_score, status, submitted_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [student_name.trim(), Number(activity_id), mode, numericScore, status]
    );

    res.status(201).json({
      message: `Submission recorded (${status})! Score: ${numericScore} / ${maxScore}.`
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        error: 'Policy Violation: You have already submitted an answer for this activity.'
      });
    }
    console.error('POST /api/submissions error:', err);
    res.status(500).json({ error: 'Database error while recording submission.' });
  }
});

// 4. Teacher real-time monitoring feed
app.get('/api/tracking', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        s.id,
        s.student_name,
        a.title AS activity_title,
        a.max_score,
        s.mode,
        s.raw_score,
        s.status,
        s.submitted_at
      FROM submissions s
      JOIN activities a ON s.activity_id = a.id
      ORDER BY s.submitted_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/tracking error:', err);
    res.status(500).json({ error: 'Failed to load tracking records.' });
  }
});

// 5. Reset simulator data (optional demo helper)
app.delete('/api/reset', async (req, res) => {
  try {
    await pool.query('DELETE FROM submissions');
    await pool.query('DELETE FROM activities');
    res.json({ message: 'Simulator data cleared.' });
  } catch (err) {
    console.error('DELETE /api/reset error:', err);
    res.status(500).json({ error: 'Failed to reset data.' });
  }
});

const PORT = process.env.PORT || 3007;
app.listen(PORT, () => {
  console.log(`SLPMS Backend running on http://localhost:${PORT}`);
});