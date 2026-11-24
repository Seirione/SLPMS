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
  const { title, max_score, deadline, penalty_per_miss, max_allowed_misses } = req.body;
  if (!title || !max_score || !deadline) {
    return res.status(400).json({ error: 'Title, max_score, and deadline are required.' });
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO activities (title, max_score, deadline, penalty_per_miss, max_allowed_misses)
       VALUES (?, ?, ?, ?, ?)`,
      [
        title.trim(),
        Number(max_score),
        deadline,
        penalty_per_miss !== undefined ? Number(penalty_per_miss) : 5,
        max_allowed_misses !== undefined ? Number(max_allowed_misses) : 2
      ]
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

    const now = new Date();
    const dueDate = new Date(activity.deadline);
    const status = now > dueDate ? 'Late' : 'On-Time';

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

// 4. Teacher real-time monitoring feed & student support graph aggregation
app.get('/api/tracking', async (req, res) => {
  try {
    const [activities] = await pool.query('SELECT * FROM activities ORDER BY id DESC');
    const [submissions] = await pool.query(`
      SELECT s.student_name, s.activity_id, s.mode, s.raw_score, s.status, a.max_score
      FROM submissions s
      JOIN activities a ON s.activity_id = a.id
    `);

    const totalActivities = activities.length;
    const totalPossiblePoints = activities.reduce((sum, a) => sum + Number(a.max_score || 0), 0);

    // Use the latest activity's rules (or defaults if none exist yet)
    const latestRule = activities[0] || {};
    const penaltyPerMiss = Number(latestRule.penalty_per_miss ?? 5);
    const maxAllowedMisses = Number(latestRule.max_allowed_misses ?? 2);

    // Group submissions by student_name
    const studentMap = new Map();

    for (const sub of submissions) {
      const name = sub.student_name.trim();
      if (!studentMap.has(name)) {
        studentMap.set(name, {
          student_name: name,
          completed: 0,
          raw_total: 0,
          online_count: 0,
          offline_count: 0
        });
      }
      const record = studentMap.get(name);
      record.completed += 1;
      record.raw_total += Number(sub.raw_score || 0);
      if (sub.mode === 'Offline') {
        record.offline_count += 1;
      } else {
        record.online_count += 1;
      }
    }

    const students = Array.from(studentMap.values()).map((st) => {
      const misses = Math.max(0, totalActivities - st.completed);
      const penalty = misses * penaltyPerMiss;
      const netScore = Math.max(0, st.raw_total - penalty);
      const percentage = totalPossiblePoints > 0
        ? Math.round((netScore / totalPossiblePoints) * 100)
        : 0;

      const preferredMode = st.offline_count > st.online_count ? 'Offline' : 'Online';
      const needsSupport = percentage < 75 || misses > maxAllowedMisses;

      return {
        student_name: st.student_name,
        completed: `${st.completed} / ${totalActivities}`,
        misses,
        net_score: netScore,
        percentage,
        preferred_mode: preferredMode,
        needs_support: needsSupport
      };
    });

    // Sort lowest percentage first so students needing support stand out
    students.sort((a, b) => a.percentage - b.percentage);

    res.json({
      total_activities: totalActivities,
      rules: {
        penalty_per_miss: penaltyPerMiss,
        max_allowed_misses: maxAllowedMisses
      },
      students
    });
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