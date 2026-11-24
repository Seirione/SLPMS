const express = require('express');
const cors = require('cors');
require('dotenv').config();
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// 1. TEACHER: Create a new Quiz / Activity
app.post('/api/activities', async (req, res) => {
  try {
    const { title, max_score, deadline, penalty_per_miss, max_allowed_misses } = req.body;
    const formattedDeadline = deadline.replace('T', ' ');

    const [result] = await db.query(
      `INSERT INTO activities (title, max_score, deadline, penalty_per_miss, max_allowed_misses)
       VALUES (?, ?, ?, ?, ?)`,
      [title, max_score, formattedDeadline, penalty_per_miss, max_allowed_misses]
    );
    res.json({ message: 'Activity published!', id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. BOTH: Get all activities
app.get('/api/activities', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM activities ORDER BY id DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. STUDENT: Submit an activity (STRICTLY ONCE per activity per student)
app.post('/api/submissions', async (req, res) => {
  try {
    const { activity_id, student_name, mode, raw_score } = req.body;
    const cleanName = student_name.trim();

    // Check if student already submitted this activity
    const [existing] = await db.query(
      'SELECT id FROM submissions WHERE activity_id = ? AND student_name = ?',
      [activity_id, cleanName]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        error: `Duplicate blocked: "${cleanName}"Ikaw ay nag submit na.`
      });
    }

    await db.query(
      `INSERT INTO submissions (activity_id, student_name, mode, raw_score, submitted_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [activity_id, cleanName, mode, raw_score || 0]
    );

    res.json({
      message: `Submission recorded (${mode}) for ${cleanName}!`
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        error: 'You have already submitted this activity. Multiple submissions are not allowed.'
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// 4. TEACHER: Real-Time Tracking + Live Class Baseline for Simulator
app.get('/api/tracking', async (req, res) => {
  try {
    const [activities] = await db.query('SELECT * FROM activities ORDER BY id ASC');
    const [submissions] = await db.query('SELECT * FROM submissions ORDER BY submitted_at ASC');

    const students = [...new Set(submissions.map(s => s.student_name))];
    const now = new Date();

    const latestRule = activities[activities.length - 1] || {
      penalty_per_miss: 5,
      max_allowed_misses: 2
    };

    const report = students.map(student => {
      let totalRawScore = 0;
      let totalMaxScore = 0;
      let misses = 0;
      let completedActivities = 0;
      let onlineCount = 0;
      let offlineCount = 0;

      activities.forEach(act => {
        totalMaxScore += act.max_score;
        const sub = submissions.find(
          s => s.student_name === student && s.activity_id === act.id
        );
        const deadlineDate = new Date(act.deadline);

        if (!sub) {
          if (now > deadlineDate) misses++;
        } else {
          completedActivities++;
          totalRawScore += sub.raw_score;
          if (sub.mode === 'Online') onlineCount++;
          if (sub.mode === 'Offline') offlineCount++;
          if (new Date(sub.submitted_at) > deadlineDate) misses++;
        }
      });

      const totalPenalty = misses * latestRule.penalty_per_miss;
      const netScore = Math.max(0, totalRawScore - totalPenalty);
      const percentage = totalMaxScore > 0 ? Math.round((netScore / totalMaxScore) * 100) : 0;
      const needsSupport = percentage < 75 || misses > latestRule.max_allowed_misses;

      let supportReason = 'On Track';
      if (percentage < 75 && misses > latestRule.max_allowed_misses) {
        supportReason = 'Low Score (<75%) & Missed Deadlines';
      } else if (percentage < 75) {
        supportReason = 'Low Net Score (<75%)';
      } else if (misses > latestRule.max_allowed_misses) {
        supportReason = 'Exceeded Allowed Misses';
      }

      const preferredMode =
        onlineCount > offlineCount
          ? `Online (${onlineCount})`
          : offlineCount > onlineCount
          ? `Offline (${offlineCount})`
          : `Mixed (${onlineCount} On / ${offlineCount} Off)`;

      return {
        student_name: student,
        completed: `${completedActivities} / ${activities.length}`,
        misses,
        penalty_deducted: totalPenalty,
        raw_score: totalRawScore,
        net_score: `${netScore} / ${totalMaxScore}`,
        percentage,
        preferred_mode: preferredMode,
        needs_support: needsSupport,
        support_reason: supportReason
      };
    });

    res.json({
      rules: latestRule,
      total_activities: activities.length,
      students: report
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3007;
app.listen(PORT, () => {
  console.log(`SLPMS Backend running on http://localhost:${PORT}`);
});