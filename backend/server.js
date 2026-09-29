const express = require("express");
const path = require("path");
const mysql = require("mysql2");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: "ibex2026",
    resave: false,
    saveUninitialized: false,
  }),
);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "../frontend/views"));
app.use(express.static(path.join(__dirname, "../frontend/public")));

// MySQL Connection - tumia database yako students_db
const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "Eduedwin@74", // weka password kama uko nayo
  database: "students_db",
});

const query = (sql, values = []) =>
  new Promise((resolve, reject) => {
    db.query(sql, values, (err, results) =>
      err ? reject(err) : resolve(results),
    );
  });

const isAuthenticated = (req, res, next) => {
  if (!req.session.user) return res.redirect("/login");
  next();
};

const authorizeRoles = (roles) => (req, res, next) => {
  if (!req.session.user) return res.redirect("/login");
  if (!roles.includes(req.session.user.role)) {
    return res.status(403).send("You are not authorized to access this page.");
  }
  next();
};

app.use(
  ["/teachers", "/classes", "/grades", "/attendance", "/reports", "/fees"],
  isAuthenticated,
);

const escapeIdentifier = (identifier) =>
  `\`${identifier.replace(/`/g, "``")}\``;

const getAttendanceSummary = async (studentId) => {
  const rows = await query(
    "SELECT COUNT(*) AS total, SUM(status IN ('present', 'late')) AS attended FROM attendance WHERE student_id = ?",
    [studentId],
  );
  const total = Number(rows[0].total) || 0;
  const attended = Number(rows[0].attended) || 0;
  return {
    total,
    attended,
    percentage: total ? Math.round((attended / total) * 100) : 0,
  };
};

const gradeLabel = (mean) => {
  if (mean >= 80) return "A";
  if (mean >= 70) return "B";
  if (mean >= 60) return "C";
  if (mean >= 50) return "D";
  return "F";
};

const escapePdfText = (value) =>
  String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");

const createReportPdf = (lines) => {
  const content = ["BT", "/F1 14 Tf", "50 760 Td"];
  lines.forEach((line, index) => {
    if (index > 0) content.push("0 -22 Td");
    content.push(`(${escapePdfText(line)}) Tj`);
  });
  content.push("ET");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content.join("\n"), "ascii")} >>\nstream\n${content.join("\n")}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "ascii");
};

const getStudentReport = async (studentId) => {
  const students = await query(
    "SELECT name, class FROM students WHERE id = ? LIMIT 1",
    [studentId],
  );
  if (!students.length) return null;
  const grades = await query(
    "SELECT subject, term, score FROM grades WHERE student_id = ? ORDER BY subject, term",
    [studentId],
  );
  const meanRows = await query(
    "SELECT AVG(score) AS mean FROM grades WHERE student_id = ? AND score IS NOT NULL",
    [studentId],
  );
  const mean = Number(meanRows[0].mean) || 0;
  return {
    student: students[0],
    grades,
    mean: Math.round(mean * 100) / 100,
    grade: gradeLabel(mean),
    term: grades.find((grade) => grade.term)?.term || "All Terms",
    attendance: await getAttendanceSummary(studentId),
  };
};

const getAdminDashboardData = async () => {
  const [feesSummary, attendanceRows, performanceRows, feesMonthly, classRows] =
    await Promise.all([
      query(
        "SELECT COALESCE(SUM(paid_amount), 0) AS collected, COALESCE(SUM(balance), 0) AS pending FROM fees",
      ),
      query(
        "SELECT status, COUNT(*) AS count FROM attendance WHERE date = CURDATE() GROUP BY status",
      ),
      query(
        "SELECT students.class AS class, ROUND(AVG(grades.score), 2) AS avg FROM grades JOIN students ON students.id = grades.student_id WHERE students.class IS NOT NULL AND students.class <> '' GROUP BY students.class ORDER BY students.class",
      ),
      query(
        "SELECT DATE_FORMAT(created_at, '%b') AS month, SUM(paid_amount) AS total FROM fees WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 5 MONTH) GROUP BY YEAR(created_at), MONTH(created_at), DATE_FORMAT(created_at, '%b') ORDER BY YEAR(created_at), MONTH(created_at)",
      ),
      query(
        "SELECT class, COUNT(*) AS count FROM students WHERE class IS NOT NULL AND class <> '' GROUP BY class ORDER BY class",
      ),
    ]);

  const attendanceStats = { present: 0, absent: 0, late: 0 };
  attendanceRows.forEach((row) => {
    attendanceStats[row.status] = Number(row.count);
  });
  return {
    totalFeesCollected: Number(feesSummary[0].collected) || 0,
    totalFeesPending: Number(feesSummary[0].pending) || 0,
    chartData: {
      attendanceStats,
      classPerformance: performanceRows.map((row) => ({
        class: row.class,
        avg: Number(row.avg) || 0,
      })),
      feesMonthly: feesMonthly.map((row) => ({
        month: row.month,
        total: Number(row.total) || 0,
      })),
      studentCounts: classRows.map((row) => ({
        class: row.class,
        count: Number(row.count) || 0,
      })),
    },
  };
};

const repairStudentColumns = async () => {
  let columns;
  try {
    columns = await query("SHOW COLUMNS FROM students");
  } catch (error) {
    console.log("Schema check error:", error.message);
    return;
  }

  const columnNames = columns.map((column) => column.Field);
  const lowerCaseNames = new Map(
    columnNames.map((columnName) => [columnName.toLowerCase(), columnName]),
  );
  const admissionColumn = lowerCaseNames.get("admissionno");
  const legacyAdmissionColumn = ["admisionno", "admission_no", "reg_no"]
    .map((columnName) => lowerCaseNames.get(columnName))
    .find(Boolean);
  const parentContactColumn = lowerCaseNames.get("parentcontact");
  const legacyParentContactColumn = ["parent_phone", "parentphone"]
    .map((columnName) => lowerCaseNames.get(columnName))
    .find(Boolean);

  const repairs = [];
  if (!admissionColumn && legacyAdmissionColumn) {
    repairs.push(
      `CHANGE COLUMN ${escapeIdentifier(legacyAdmissionColumn)} admissionNo VARCHAR(20)`,
    );
  }
  if (!parentContactColumn && legacyParentContactColumn) {
    repairs.push(
      `CHANGE COLUMN ${escapeIdentifier(legacyParentContactColumn)} parentContact VARCHAR(20)`,
    );
  }

  if (repairs.length === 0) return;

  try {
    await query(`ALTER TABLE students ${repairs.join(", ")}`);
    console.log("✅ Repaired legacy students table column names");
  } catch (error) {
    console.log("Schema repair error:", error.message);
  }
};

const initializeSchema = async () => {
  await query(
    "ALTER TABLE users MODIFY role ENUM('admin','teacher','parent','student') NOT NULL",
  );

  const gradeColumns = await query("SHOW COLUMNS FROM grades");
  if (gradeColumns.some((column) => column.Field === "course_id")) {
    await query("ALTER TABLE grades MODIFY course_id INT NULL");
  }
  if (!gradeColumns.some((column) => column.Field === "subject")) {
    await query("ALTER TABLE grades ADD COLUMN subject VARCHAR(50) NULL");
  }
  if (!gradeColumns.some((column) => column.Field === "term")) {
    await query("ALTER TABLE grades ADD COLUMN term VARCHAR(20) NULL");
  }
  if (!gradeColumns.some((column) => column.Field === "grade")) {
    await query("ALTER TABLE grades ADD COLUMN grade VARCHAR(2) NULL");
  }
  if (!gradeColumns.some((column) => column.Field === "created_at")) {
    await query(
      "ALTER TABLE grades ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
    );
  }

  const userColumns = await query("SHOW COLUMNS FROM users");
  if (!userColumns.some((column) => column.Field === "linked_id")) {
    await query("ALTER TABLE users ADD COLUMN linked_id INT NULL");
  }
  if (!userColumns.some((column) => column.Field === "subject")) {
    await query("ALTER TABLE users ADD COLUMN subject VARCHAR(100) NULL");
  }
  if (!userColumns.some((column) => column.Field === "qualification")) {
    await query("ALTER TABLE users ADD COLUMN qualification VARCHAR(100) NULL");
  }
  if (!userColumns.some((column) => column.Field === "tsc_no")) {
    await query("ALTER TABLE users ADD COLUMN tsc_no VARCHAR(50) NULL");
  }

  const studentIndexes = await query("SHOW INDEX FROM students");
  const hasUniqueAdmissionNo = studentIndexes.some(
    (index) => index.Column_name === "admissionNo" && index.Non_unique === 0,
  );
  if (!hasUniqueAdmissionNo) {
    await query(
      "ALTER TABLE students ADD UNIQUE KEY uq_students_admissionNo (admissionNo)",
    );
  }

  const teacherColumns = await query("SHOW COLUMNS FROM teachers");
  if (!teacherColumns.some((column) => column.Field === "tscNo")) {
    await query("ALTER TABLE teachers ADD COLUMN tscNo VARCHAR(50) NULL");
  }

  await query(
    "CREATE TABLE IF NOT EXISTS attendance (id INT AUTO_INCREMENT PRIMARY KEY, student_id INT NOT NULL, date DATE NOT NULL, status ENUM('present','absent','late') NOT NULL, marked_by INT NULL, UNIQUE KEY uq_attendance_student_date (student_id, date))",
  );
  const attendanceColumns = await query("SHOW COLUMNS FROM attendance");
  if (!attendanceColumns.some((column) => column.Field === "marked_by")) {
    await query("ALTER TABLE attendance ADD COLUMN marked_by INT NULL");
  }
  await query(
    "ALTER TABLE attendance MODIFY status ENUM('present','absent','late') NOT NULL DEFAULT 'present'",
  );
  const attendanceIndexes = await query("SHOW INDEX FROM attendance");
  if (
    !attendanceIndexes.some(
      (index) => index.Key_name === "uq_attendance_student_date",
    )
  ) {
    await query(
      "ALTER TABLE attendance ADD UNIQUE KEY uq_attendance_student_date (student_id, date)",
    );
  }

  await query(
    "CREATE TABLE IF NOT EXISTS fees (id INT AUTO_INCREMENT PRIMARY KEY, student_id INT, term VARCHAR(20), total_amount DECIMAL(10,2) DEFAULT 15000, paid_amount DECIMAL(10,2) DEFAULT 0, balance DECIMAL(10,2) GENERATED ALWAYS AS (total_amount - paid_amount) STORED, payment_method ENUM('cash','mpesa','bank') NULL, mpesa_code VARCHAR(20) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (student_id) REFERENCES students(id))",
  );
};

db.connect(async (err) => {
  if (err) {
    console.log("❌ DB Error:", err.message);
    console.log(
      "Fungua XAMPP na hakikisha MySQL imewashwa na DB students_db ipo",
    );
  } else {
    console.log("✅ MySQL Connected to students_db");
    try {
      await repairStudentColumns();
      await initializeSchema();
    } catch (schemaError) {
      console.log("Schema migration error:", schemaError.message);
    }
    app.listen(3000, () =>
      console.log("✅ BACKEND running http://localhost:3000"),
    );
  }
});

app.get("/", (req, res) =>
  res.redirect(req.session.user ? "/dashboard" : "/login"),
);

app.get("/register", (req, res) => res.render("register", { error: null }));
app.post("/register", async (req, res) => {
  const {
    name,
    email,
    password,
    confirmPassword,
    role,
    admissionNo,
    class: className,
    subject,
    qualification,
    tscNo,
    childAdmissionNo,
    phone,
    adminSecret,
  } = req.body;
  const normalizedEmail = String(email || "")
    .trim()
    .toLowerCase();
  const validRoles = ["student", "teacher", "parent", "admin"];
  const renderError = (error) => res.status(400).render("register", { error });

  if (!name || !normalizedEmail || !password || !validRoles.includes(role)) {
    return renderError("Complete all required account fields.");
  }
  if (confirmPassword && password !== confirmPassword)
    return renderError("Passwords do not match.");

  try {
    const existingUser = await query(
      "SELECT id FROM users WHERE email = ? LIMIT 1",
      [normalizedEmail],
    );
    if (existingUser.length)
      return renderError("That email is already registered.");

    let linkedId = null;
    if (role === "parent" && childAdmissionNo) {
      const child = await query(
        "SELECT id FROM students WHERE admissionNo = ? LIMIT 1",
        [childAdmissionNo],
      );
      if (!child.length)
        return renderError("No student exists with that admission number.");
      linkedId = child[0].id;
      await query("UPDATE students SET parentContact = ? WHERE id = ?", [
        phone || null,
        linkedId,
      ]);
    }
    if (role === "student" && admissionNo) {
      const existingStudent = await query(
        "SELECT id FROM students WHERE admissionNo = ? LIMIT 1",
        [admissionNo],
      );
      if (existingStudent.length)
        return renderError("That admission number already exists.");
      const student = await query(
        "INSERT INTO students (admissionNo, name, class, parentContact) VALUES (?, ?, ?, ?)",
        [admissionNo, name, className, null],
      );
      linkedId = student.insertId;
    }
    if (role === "teacher") {
      const teacher = await query(
        "INSERT INTO teachers (name, subject, qualification, tscNo) VALUES (?, ?, ?, ?)",
        [name, subject, qualification || null, tscNo || null],
      );
      linkedId = teacher.insertId;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await query(
      "INSERT INTO users (name, email, password, role, linked_id, subject, qualification, tsc_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        name,
        normalizedEmail,
        passwordHash,
        role,
        linkedId,
        subject || null,
        qualification || null,
        tscNo || null,
      ],
    );
    res.redirect("/login?registered=1");
  } catch (error) {
    console.error(error);
    console.log("Registration error:", error.message);
    res
      .status(500)
      .render("register", { error: "Could not create the account." });
  }
});

app.get("/login", (req, res) =>
  res.render("login", {
    error: null,
    registered: req.query.registered === "1",
  }),
);
app.post("/login", async (req, res) => {
  try {
    const users = await query(
      "SELECT id, name, email, password, role, linked_id FROM users WHERE email = ? LIMIT 1",
      [
        String(req.body.email || "")
          .trim()
          .toLowerCase(),
      ],
    );
    if (
      !users.length ||
      !(await bcrypt.compare(req.body.password || "", users[0].password))
    ) {
      return res.status(401).render("login", {
        error: "Invalid email or password.",
        registered: false,
      });
    }
    const { id, name, email, role, linked_id } = users[0];
    req.session.user = { id, name, email, role, linked_id };
    res.redirect("/dashboard");
  } catch (error) {
    console.log("Login error:", error.message);
    res
      .status(500)
      .render("login", { error: "Could not log in.", registered: false });
  }
});

app.get("/logout", (req, res) =>
  req.session.destroy(() => res.redirect("/login")),
);

app.get("/dashboard", isAuthenticated, async (req, res) => {
  const user = req.session.user;
  const data = {
    totalStudents: 0,
    totalTeachers: 0,
    totalParents: 0,
    totalUsers: 0,
    totalFeesCollected: 0,
    totalFeesPending: 0,
  };
  let chartData = {
    attendanceStats: { present: 0, absent: 0, late: 0 },
    classPerformance: [],
    feesMonthly: [],
    studentCounts: [],
  };
  try {
    if (user.role === "admin") {
      const counts = await Promise.all([
        query("SELECT COUNT(*) AS count FROM students"),
        query("SELECT COUNT(*) AS count FROM teachers"),
        query("SELECT COUNT(*) AS count FROM users WHERE role = 'parent'"),
        query("SELECT COUNT(*) AS count FROM users"),
      ]);
      [
        data.totalStudents,
        data.totalTeachers,
        data.totalParents,
        data.totalUsers,
      ] = counts.map((result) => result[0].count);
      const adminData = await getAdminDashboardData();
      data.totalFeesCollected = adminData.totalFeesCollected;
      data.totalFeesPending = adminData.totalFeesPending;
      chartData = adminData.chartData;
    } else if (user.role === "parent" || user.role === "student") {
      if (user.linked_id) {
        const studentRows = await query(
          "SELECT * FROM students WHERE id = ? LIMIT 1",
          [user.linked_id],
        );
        data.student = studentRows[0];
        data.grades = await query(
          "SELECT * FROM grades WHERE student_id = ? ORDER BY term DESC, subject LIMIT 5",
          [user.linked_id],
        );
        data.attendance = await query(
          "SELECT * FROM attendance WHERE student_id = ? ORDER BY date DESC",
          [user.linked_id],
        );
        data.attendanceSummary = await getAttendanceSummary(user.linked_id);
      }
    } else if (user.role === "teacher") {
      data.classes = await query(
        "SELECT * FROM classes WHERE teacherName = ?",
        [user.name],
      );
    }
  } catch (error) {
    console.log("Dashboard query error:", error.message);
  }
  res.render("dashboard", { user, data, chartData });
});

app.get("/grades", isAuthenticated, async (req, res) => {
  try {
    const user = req.session.user;
    const canManage = ["admin", "teacher"].includes(user.role);
    const studentId = canManage ? req.query.studentId : user.linked_id;
    const grades = studentId
      ? await query(
          "SELECT grades.*, students.name AS student_name FROM grades JOIN students ON students.id = grades.student_id WHERE grades.student_id = ? ORDER BY grades.term DESC, grades.subject",
          [studentId],
        )
      : await query(
          "SELECT grades.*, students.name AS student_name FROM grades JOIN students ON students.id = grades.student_id ORDER BY students.name, grades.term DESC, grades.subject",
        );
    const students = canManage
      ? await query("SELECT id, name, admissionNo FROM students ORDER BY name")
      : [];
    res.render("grades", {
      user,
      grades,
      students,
      selectedStudentId: studentId || "",
    });
  } catch (error) {
    console.log("Grades query error:", error.message);
    res.status(500).send("Could not load grades.");
  }
});

app.post(
  "/grades/add",
  isAuthenticated,
  authorizeRoles(["admin", "teacher"]),
  async (req, res) => {
    const { studentId, subject, term, score } = req.body;
    const numericScore = Number(score);
    if (
      !studentId ||
      !subject ||
      !term ||
      !Number.isFinite(numericScore) ||
      numericScore < 0 ||
      numericScore > 100
    ) {
      return res
        .status(400)
        .send(
          "Student, subject, term, and a score from 0 to 100 are required.",
        );
    }
    try {
      await query(
        "INSERT INTO grades (student_id, subject, term, score) VALUES (?, ?, ?, ?)",
        [studentId, subject, term, numericScore],
      );
      res.redirect(`/grades?studentId=${encodeURIComponent(studentId)}`);
    } catch (error) {
      console.error(error);
      console.log("Grade insert error:", error.message);
      res.status(500).send("Could not add grade.");
    }
  },
);

app.get("/attendance", isAuthenticated, async (req, res) => {
  try {
    const user = req.session.user;
    const canManage = ["admin", "teacher"].includes(user.role);
    if (!canManage) {
      const summary = user.linked_id
        ? await getAttendanceSummary(user.linked_id)
        : { total: 0, attended: 0, percentage: 0 };
      return res.render("attendance", {
        user,
        canManage: false,
        summary,
        records: user.linked_id
          ? await query(
              "SELECT * FROM attendance WHERE student_id = ? ORDER BY date DESC",
              [user.linked_id],
            )
          : [],
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const students = await query(
      "SELECT id, name, admissionNo, class FROM students ORDER BY name",
    );
    const records = await query("SELECT * FROM attendance WHERE date = ?", [
      today,
    ]);
    const recordByStudent = Object.fromEntries(
      records.map((record) => [record.student_id, record.status]),
    );
    res.render("attendance", {
      user,
      canManage: true,
      students,
      recordByStudent,
      today,
    });
  } catch (error) {
    console.log("Attendance query error:", error.message);
    res.status(500).send("Could not load attendance.");
  }
});

app.post(
  "/attendance/mark",
  isAuthenticated,
  authorizeRoles(["admin", "teacher"]),
  async (req, res) => {
    const statuses = req.body.status || {};
    const date = req.body.date || new Date().toISOString().slice(0, 10);
    const validStatuses = ["present", "absent", "late"];
    try {
      for (const [studentId, status] of Object.entries(statuses)) {
        if (!validStatuses.includes(status)) continue;
        await query(
          "INSERT INTO attendance (student_id, date, status, marked_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = VALUES(status), marked_by = VALUES(marked_by)",
          [studentId, date, status, req.session.user.id],
        );
      }
      res.redirect("/attendance");
    } catch (error) {
      console.log("Attendance insert error:", error.message);
      res.status(500).send("Could not save attendance.");
    }
  },
);

app.get("/reports", isAuthenticated, async (req, res) => {
  try {
    const user = req.session.user;
    const canManage = ["admin", "teacher"].includes(user.role);
    let studentId = canManage ? req.query.studentId : user.linked_id;
    const search = String(req.query.search || "").trim();
    const students = canManage
      ? await query(
          "SELECT id, name, admissionNo, class FROM students WHERE name LIKE ? OR admissionNo LIKE ? ORDER BY name",
          [`%${search}%`, `%${search}%`],
        )
      : [];
    if (!studentId && !canManage) studentId = user.linked_id;
    const report = studentId ? await getStudentReport(studentId) : null;
    if (req.query.download === "1" && report) {
      const lines = [
        "Ibex System",
        "Report Card",
        `Student: ${report.student.name}`,
        `Class: ${report.student.class || ""}`,
        `Term: ${report.term}`,
        `Mean score: ${report.mean}`,
        `Grade: ${report.grade}`,
        `Attendance: ${report.attendance.percentage}%`,
        "",
        "Subject | Term | Score",
        ...report.grades.map(
          (grade) =>
            `${grade.subject || ""} | ${grade.term || ""} | ${grade.score ?? ""}`,
        ),
      ];
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="ibex-report-${studentId}.pdf"`,
      );
      return res.type("application/pdf").send(createReportPdf(lines));
    }
    res.render("reports", {
      user,
      canManage,
      students,
      report,
      search,
      selectedStudentId: studentId || "",
    });
  } catch (error) {
    console.log("Report query error:", error.message);
    res.status(500).send("Could not load report.");
  }
});

app.get("/fees", isAuthenticated, async (req, res) => {
  try {
    const user = req.session.user;
    const canManage = ["admin", "teacher"].includes(user.role);
    const fees = canManage
      ? await query(
          "SELECT fees.*, students.name AS student_name, students.admissionNo FROM fees JOIN students ON students.id = fees.student_id ORDER BY fees.created_at DESC, students.name",
        )
      : user.linked_id
        ? await query(
            "SELECT fees.*, students.name AS student_name, students.admissionNo FROM fees JOIN students ON students.id = fees.student_id WHERE fees.student_id = ? ORDER BY fees.created_at DESC",
            [user.linked_id],
          )
        : [];
    const students =
      user.role === "admin"
        ? await query(
            "SELECT id, name, admissionNo FROM students ORDER BY name",
          )
        : [];
    res.render("fees", {
      user,
      fees,
      students,
      canManage: user.role === "admin",
    });
  } catch (error) {
    console.log("Fees query error:", error.message);
    res.status(500).send("Could not load fees.");
  }
});

app.post(
  "/fees/add",
  isAuthenticated,
  authorizeRoles(["admin"]),
  async (req, res) => {
    const {
      student_id: studentId,
      term,
      paid_amount: paidAmount,
      payment_method: paymentMethod,
      mpesa_code: mpesaCode,
    } = req.body;
    const amount = Number(paidAmount);
    if (
      !studentId ||
      !term ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !["cash", "mpesa", "bank"].includes(paymentMethod)
    ) {
      return res
        .status(400)
        .send(
          "Student, term, valid payment method, and a positive amount are required.",
        );
    }
    if (paymentMethod === "mpesa" && !mpesaCode) {
      return res
        .status(400)
        .send("An M-Pesa code is required for M-Pesa payments.");
    }
    try {
      const existing = await query(
        "SELECT id FROM fees WHERE student_id = ? AND term = ? ORDER BY id LIMIT 1",
        [studentId, term],
      );
      if (existing.length) {
        await query(
          "UPDATE fees SET paid_amount = paid_amount + ?, payment_method = ?, mpesa_code = ? WHERE id = ?",
          [amount, paymentMethod, mpesaCode || null, existing[0].id],
        );
      } else {
        await query(
          "INSERT INTO fees (student_id, term, total_amount, paid_amount, payment_method, mpesa_code) VALUES (?, ?, 15000, ?, ?, ?)",
          [studentId, term, amount, paymentMethod, mpesaCode || null],
        );
      }
      res.redirect("/fees");
    } catch (error) {
      console.log("Fee payment error:", error.message);
      res.status(500).send("Could not save fee payment.");
    }
  },
);

app.post(
  "/fees/create-term",
  isAuthenticated,
  authorizeRoles(["admin"]),
  async (req, res) => {
    const { term, total_amount: totalAmount } = req.body;
    const amount = Number(totalAmount || 15000);
    if (!term || !Number.isFinite(amount) || amount < 0) {
      return res
        .status(400)
        .send("A term and valid total amount are required.");
    }
    try {
      await query(
        "INSERT INTO fees (student_id, term, total_amount, paid_amount) SELECT students.id, ?, ?, 0 FROM students WHERE NOT EXISTS (SELECT 1 FROM fees WHERE fees.student_id = students.id AND fees.term = ?)",
        [term, amount, term],
      );
      res.redirect("/fees");
    } catch (error) {
      console.log("Fee term error:", error.message);
      res.status(500).send("Could not create fee term.");
    }
  },
);

// Inspect the active students table when diagnosing schema mismatches.
app.get("/debug", isAuthenticated, authorizeRoles(["admin"]), (req, res) => {
  db.query("DESCRIBE students", (err, results) => {
    if (err) {
      console.log("Debug query error:", err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json({ database: "students_db", table: "students", columns: results });
  });
});

app.get(
  "/users",
  isAuthenticated,
  authorizeRoles(["admin"]),
  async (req, res) => {
    try {
      const users = await query(
        "SELECT id, name, email, role, linked_id FROM users ORDER BY id DESC",
      );
      res.render("users", { user: req.session.user, users });
    } catch (error) {
      console.log("Users query error:", error.message);
      res.status(500).send("Could not load users.");
    }
  },
);

app.post(
  "/users/delete/:id",
  isAuthenticated,
  authorizeRoles(["admin"]),
  async (req, res) => {
    if (Number(req.params.id) === Number(req.session.user.id)) {
      return res.status(400).send("You cannot delete your own active account.");
    }
    try {
      await query("DELETE FROM users WHERE id = ?", [req.params.id]);
      res.redirect("/users");
    } catch (error) {
      console.log("User delete error:", error.message);
      res.status(500).send("Could not delete user.");
    }
  },
);

// LIST STUDENTS - SASA INATOKA DB
app.get(
  "/students",
  isAuthenticated,
  authorizeRoles(["admin", "teacher"]),
  (req, res) => {
    db.query("SELECT * FROM students ORDER BY id DESC", (err, results) => {
      if (err) {
        console.log("Query error:", err.message);
        return res.status(500).send("Could not load students.");
      }
      console.log(`Found ${results.length} students`);
      res.render("students", { user: req.session.user, students: results });
    });
  },
);

// ADD FORM
app.get(
  "/students/add",
  isAuthenticated,
  authorizeRoles(["admin", "teacher"]),
  (req, res) => res.render("add_student", { user: req.session.user }),
);
app.get(
  "/add_student",
  isAuthenticated,
  authorizeRoles(["admin", "teacher"]),
  (req, res) => res.render("add_student", { user: req.session.user }),
);

// SAVE STUDENT - na columns zako sahihi
app.post(
  "/students/add",
  isAuthenticated,
  authorizeRoles(["admin", "teacher"]),
  (req, res) => {
    const {
      name,
      admissionNo,
      reg_no,
      class: className,
      className: cn,
      parentContact,
      parentPhone,
      admission_no,
      parent_phone,
    } = req.body;

    const finalAdmissionNo = admissionNo || admission_no || reg_no;
    const finalClass = className || cn || req.body.class_name;
    const finalContact = parentContact || parent_phone || parentPhone;

    const sql =
      "INSERT INTO students (admissionNo, name, class, parentContact) VALUES (?, ?, ?, ?)";
    db.query(
      "SELECT id FROM students WHERE admissionNo = ? LIMIT 1",
      [finalAdmissionNo],
      (lookupErr, existingStudents) => {
        if (lookupErr) {
          console.log("Student lookup error:", lookupErr.message);
          return res.status(500).send("Error checking admission number");
        }
        if (existingStudents.length > 0) {
          return res
            .status(409)
            .send("Admission number already exists. Use a different number.");
        }

        db.query(
          sql,
          [finalAdmissionNo, name, finalClass, finalContact],
          (err) => {
            if (err) {
              console.log("Insert error:", err.message);
              if (err.code === "ER_DUP_ENTRY") {
                return res
                  .status(409)
                  .send("A student with this unique value already exists.");
              }
              return res.status(500).send("Error saving student");
            }
            res.redirect("/students");
          },
        );
      },
    );
  },
);

app.get(
  "/students/edit/:id",
  isAuthenticated,
  authorizeRoles(["admin", "teacher"]),
  (req, res) => {
    db.query(
      "SELECT * FROM students WHERE id =?",
      [req.params.id],
      (err, results) => {
        if (err || results.length === 0) return res.redirect("/students");
        res.render("edit_student", {
          user: req.session.user,
          student: results[0],
        });
      },
    );
  },
);

// The database connection and migrations are initialized before serving requests.
