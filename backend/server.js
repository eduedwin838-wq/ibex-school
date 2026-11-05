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
  password: "Eduedwin@74",
  database: "students_db",
});

const query = (sql, values = []) =>
  new Promise((resolve, reject) => {
    db.query(sql, values, (err, results) =>
      err ? reject(err) : resolve(results),
    );
  });

const getClassOptions = async () => {
  const classes = await query(
    "SELECT name, stream FROM classes ORDER BY name, stream",
  );
  return classes.map(({ name, stream }) => ({
    value: stream ? `${name} - ${stream}` : name,
    name,
    stream,
  }));
};

const getTermOptions = async () => {
  const rows = await query(
    "SELECT term FROM fees WHERE term IS NOT NULL AND term <> '' UNION SELECT term FROM grades WHERE term IS NOT NULL AND term <> '' ORDER BY term",
  );
  return rows.map((row) => row.term);
};

const getFeeTermOptions = async () => {
  const rows = await query(
    "SELECT term FROM fees WHERE term IS NOT NULL AND term <> '' GROUP BY term ORDER BY MAX(created_at) DESC",
  );
  return rows.map((row) => row.term);
};

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

const isValidDate = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

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
    "SELECT subject, term, score, grade FROM grades WHERE student_id = ? ORDER BY subject, term",
    [studentId],
  );
  const meanRows = await query(
    "SELECT AVG(score) AS mean FROM grades WHERE student_id = ? AND score IS NOT NULL",
    [studentId],
  );
  const hasNumericGrades = meanRows[0].mean !== null;
  const mean = Number(meanRows[0].mean) || 0;
  return {
    student: students[0],
    grades,
    mean: Math.round(mean * 100) / 100,
    grade: hasNumericGrades ? gradeLabel(mean) : "—",
    term: grades.find((grade) => grade.term)?.term || "All Terms",
    attendance: await getAttendanceSummary(studentId),
  };
};

const getAdminDashboardData = async (selectedTerm) => {
  const hasSelectedTerm = Boolean(selectedTerm);
  const feeFilter = hasSelectedTerm ? " WHERE term = ?" : "";
  const filterValues = hasSelectedTerm ? [selectedTerm] : [];
  const [
    feesSummary,
    attendanceRows,
    previousAttendanceRows,
    performanceRows,
    feesMonthly,
    classRows,
    recentStudents,
    recentPayments,
    topDefaulters,
  ] = await Promise.all([
      query(
        `SELECT COALESCE(SUM(paid_amount), 0) AS collected, COALESCE(SUM(balance), 0) AS pending FROM fees${feeFilter}`,
        filterValues,
      ),
      query(
        "SELECT status, COUNT(*) AS count FROM attendance WHERE date = CURDATE() GROUP BY status",
      ),
      query(
        "SELECT status, COUNT(*) AS count FROM attendance WHERE date = (SELECT MAX(date) FROM attendance WHERE date < CURDATE()) GROUP BY status",
      ),
      query(
        "SELECT students.class AS class, ROUND(AVG(grades.score), 2) AS avg FROM grades JOIN students ON students.id = grades.student_id WHERE students.class IS NOT NULL AND students.class <> '' GROUP BY students.class ORDER BY students.class",
      ),
      query(
        "SELECT term, COALESCE(SUM(paid_amount), 0) AS collected, COALESCE(SUM(balance), 0) AS balance FROM fees GROUP BY term ORDER BY MAX(created_at) DESC",
      ),
      query(
        "SELECT class, COUNT(*) AS count FROM students WHERE class IS NOT NULL AND class <> '' GROUP BY class ORDER BY class",
      ),
      query(
        "SELECT id, name, admissionNo, class FROM students ORDER BY id DESC LIMIT 5",
      ),
      query(
        `SELECT fees.id, fees.student_id, fees.term, fees.total_amount, fees.paid_amount, fees.balance, fees.created_at, students.name AS student_name, students.admissionNo FROM fees JOIN students ON students.id = fees.student_id WHERE fees.paid_amount > 0${hasSelectedTerm ? " AND fees.term = ?" : ""} ORDER BY fees.created_at DESC LIMIT 6`,
        filterValues,
      ),
      query(
        `SELECT fees.student_id, fees.term, fees.balance, students.name AS student_name, students.admissionNo, students.class FROM fees JOIN students ON students.id = fees.student_id WHERE fees.balance > 0${hasSelectedTerm ? " AND fees.term = ?" : ""} ORDER BY fees.balance DESC LIMIT 5`,
        filterValues,
      ),
    ]);

  const attendanceStats = { present: 0, absent: 0, late: 0 };
  attendanceRows.forEach((row) => {
    attendanceStats[row.status] = Number(row.count);
  });
  const attendanceRecorded = Object.values(attendanceStats).reduce(
    (total, count) => total + count,
    0,
  );
  const attendancePresent = attendanceStats.present + attendanceStats.late;
  const previousAttendanceStats = { present: 0, absent: 0, late: 0 };
  previousAttendanceRows.forEach((row) => {
    previousAttendanceStats[row.status] = Number(row.count);
  });
  const previousAttendanceRecorded = Object.values(
    previousAttendanceStats,
  ).reduce((total, count) => total + count, 0);
  const previousAttendancePercentage = previousAttendanceRecorded
    ? Math.round(
        ((previousAttendanceStats.present + previousAttendanceStats.late) /
          previousAttendanceRecorded) *
          100,
      )
    : null;
  const attendanceToday = {
    recorded: attendanceRecorded,
    present: attendancePresent,
    percentage: attendanceRecorded
      ? Math.round((attendancePresent / attendanceRecorded) * 100)
      : 0,
    changePoints:
      previousAttendancePercentage === null
        ? null
        : (attendanceRecorded
            ? Math.round((attendancePresent / attendanceRecorded) * 100)
            : 0) - previousAttendancePercentage,
  };
  return {
    totalFeesCollected: Number(feesSummary[0].collected) || 0,
    totalFeesPending: Number(feesSummary[0].pending) || 0,
    attendanceToday,
    recentPayments,
    topDefaulters,
    recentStudents,
    chartData: {
    attendanceStats,
      classPerformance: performanceRows.map((row) => ({
        class: row.class,
        avg: Number(row.avg) || 0,
      })),
      feesMonthly: feesMonthly.map((row) => ({
        month: row.term,
        total: Number(row.collected) || 0,
      })),
      feesByTerm: feesMonthly.map((row) => ({
        term: row.term,
        collected: Number(row.collected) || 0,
        balance: Number(row.balance) || 0,
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
    "CREATE TABLE IF NOT EXISTS classes (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50), stream VARCHAR(50), teacherName VARCHAR(100))",
  );
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
    attendanceToday: { recorded: 0, present: 0, percentage: 0 },
    recentPayments: [],
    topDefaulters: [],
  };
  let termOptions = [];
  let selectedTerm = "";
  let chartData = {
    attendanceStats: { present: 0, absent: 0, late: 0 },
    classPerformance: [],
    feesMonthly: [],
    studentCounts: [],
  };
  try {
    if (user.role === "admin") {
      termOptions = await getFeeTermOptions();
      const requestedTerm = String(req.query.term || "");
      selectedTerm = termOptions.includes(requestedTerm)
        ? requestedTerm
        : Object.prototype.hasOwnProperty.call(req.query, "term")
          ? ""
          : termOptions[0] || "";
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
      const adminData = await getAdminDashboardData(selectedTerm);
      data.totalFeesCollected = adminData.totalFeesCollected;
      data.totalFeesPending = adminData.totalFeesPending;
      data.attendanceToday = adminData.attendanceToday;
      data.recentPayments = adminData.recentPayments;
      data.topDefaulters = adminData.topDefaulters;
      chartData = adminData.chartData;
    } else if (user.role === "parent" || user.role === "student") {
      if (user.linked_id) {
        const studentTermRows = await query(
          "SELECT term FROM fees WHERE student_id = ? AND term IS NOT NULL AND term <> '' UNION SELECT term FROM grades WHERE student_id = ? AND term IS NOT NULL AND term <> '' ORDER BY term",
          [user.linked_id, user.linked_id],
        );
        termOptions = studentTermRows.map((row) => row.term);
        const requestedTerm = String(req.query.term || "");
        selectedTerm = termOptions.includes(requestedTerm)
          ? requestedTerm
          : Object.prototype.hasOwnProperty.call(req.query, "term")
            ? ""
            : termOptions[0] || "";
        const studentRows = await query(
          "SELECT * FROM students WHERE id = ? LIMIT 1",
          [user.linked_id],
        );
        data.student = studentRows[0];
        data.grades = await query(
          "SELECT * FROM grades WHERE student_id = ? AND (? = '' OR term = ?) ORDER BY term DESC, subject LIMIT 5",
          [user.linked_id, selectedTerm, selectedTerm],
        );
        data.fees = await query(
          "SELECT term, total_amount, paid_amount, balance FROM fees WHERE student_id = ? AND (? = '' OR term = ?) ORDER BY created_at DESC",
          [user.linked_id, selectedTerm, selectedTerm],
        );
        data.attendance = await query(
          "SELECT * FROM attendance WHERE student_id = ? ORDER BY date DESC",
          [user.linked_id],
        );
        data.attendanceSummary = await getAttendanceSummary(user.linked_id);
      }
    } else if (user.role === "teacher") {
      termOptions = await getTermOptions();
      selectedTerm = termOptions.includes(String(req.query.term || ""))
        ? String(req.query.term)
        : termOptions[0] || "";
      data.classes = await query(
        "SELECT * FROM classes WHERE teacherName = ?",
        [user.name],
      );
    }
  } catch (error) {
    console.error("Dashboard query error:", error);
    return res.status(500).send("Could not load dashboard.");
  }
  res.render("dashboard", {
    user,
    data,
    chartData,
    termOptions,
    selectedTerm,
  });
});

app.get("/grades", isAuthenticated, async (req, res) => {
  try {
    const user = req.session.user;
    const canManage = ["admin", "teacher"].includes(user.role);
    const studentId = canManage ? req.query.studentId : user.linked_id;
    const termOptions = await getTermOptions();
    const requestedTerm = String(req.query.term || "");
    const selectedTerm = termOptions.includes(requestedTerm)
      ? requestedTerm
      : "";
    const grades = studentId
      ? await query(
          "SELECT grades.*, students.name AS student_name FROM grades JOIN students ON students.id = grades.student_id WHERE grades.student_id = ? AND (? = '' OR grades.term = ?) ORDER BY grades.term DESC, grades.subject",
          [studentId, selectedTerm, selectedTerm],
        )
      : await query(
          "SELECT grades.*, students.name AS student_name FROM grades JOIN students ON students.id = grades.student_id WHERE (? = '' OR grades.term = ?) ORDER BY students.name, grades.term DESC, grades.subject",
          [selectedTerm, selectedTerm],
        );
    const students = canManage
      ? await query("SELECT id, name, admissionNo FROM students ORDER BY name")
      : [];
    res.render("grades", {
      user,
      grades,
      students,
      selectedStudentId: studentId || "",
      termOptions,
      selectedTerm,
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
    const { studentId, subject, term, score, grade } = req.body;
    const hasScore = String(score ?? "").trim() !== "";
    const numericScore = hasScore ? Number(score) : null;
    const cbcGrades = ["EE", "ME", "AE", "BE"];
    if (
      !studentId ||
      !subject ||
      !term ||
      (!hasScore && !cbcGrades.includes(grade)) ||
      (hasScore &&
        (!Number.isFinite(numericScore) ||
          numericScore < 0 ||
          numericScore > 100)) ||
      (grade && !cbcGrades.includes(grade))
    ) {
      return res
        .status(400)
        .send(
          "Student, subject, term, and either a score from 0 to 100 or a valid CBC level are required.",
        );
    }
    try {
      await query(
        "INSERT INTO grades (student_id, subject, term, score, grade) VALUES (?, ?, ?, ?, ?)",
        [
          studentId,
          subject,
          term,
          numericScore,
          grade || (hasScore ? gradeLabel(numericScore) : null),
        ],
      );
      res.redirect(`/grades?studentId=${encodeURIComponent(studentId)}`);
    } catch (error) {
      console.error(error);
      console.log("Grade insert error:", error.message);
      res.status(500).send("Could not add grade.");
    }
  },
);

app.get(
  "/classes",
  isAuthenticated,
  authorizeRoles(["admin"]),
  async (req, res) => {
    try {
      const [classes, teachers] = await Promise.all([
        query(
          "SELECT classes.id, classes.name, classes.stream, classes.teacherName, (SELECT COUNT(*) FROM students WHERE students.class = CASE WHEN classes.stream IS NULL OR classes.stream = '' THEN classes.name ELSE CONCAT(classes.name, ' - ', classes.stream) END) AS studentCount FROM classes ORDER BY classes.name, classes.stream",
        ),
        query("SELECT id, name, subject FROM teachers ORDER BY name"),
      ]);
      res.render("classes", {
        user: req.session.user,
        classes,
        teachers,
        created: req.query.created === "1",
      });
    } catch (error) {
      console.log("Classes query error:", error.message);
      res.status(500).send("Could not load classes.");
    }
  },
);

app.post(
  "/classes",
  isAuthenticated,
  authorizeRoles(["admin"]),
  async (req, res) => {
    const name = String(req.body.name || "").trim();
    const stream = String(req.body.stream || "").trim();
    const teacherId = String(req.body.teacherId || "").trim();
    if (!name || name.length > 50 || stream.length > 50) {
      return res
        .status(400)
        .send("A class name of up to 50 characters is required.");
    }
    if (teacherId && !/^\d+$/.test(teacherId)) {
      return res.status(400).send("Select a valid class teacher.");
    }
    try {
      const duplicate = await query(
        "SELECT id FROM classes WHERE name = ? AND COALESCE(stream, '') = ? LIMIT 1",
        [name, stream],
      );
      if (duplicate.length) {
        return res.status(409).send("That class and stream already exist.");
      }

      let teacherName = null;
      if (teacherId) {
        const teachers = await query(
          "SELECT name FROM teachers WHERE id = ? LIMIT 1",
          [teacherId],
        );
        if (!teachers.length) {
          return res.status(400).send("The selected class teacher was not found.");
        }
        teacherName = teachers[0].name;
      }

      await query(
        "INSERT INTO classes (name, stream, teacherName) VALUES (?, ?, ?)",
        [name, stream || null, teacherName],
      );
      res.redirect("/classes?created=1");
    } catch (error) {
      console.log("Class creation error:", error.message);
      res.status(500).send("Could not create class.");
    }
  },
);

app.post(
  "/classes/delete/:id",
  isAuthenticated,
  authorizeRoles(["admin"]),
  async (req, res) => {
    try {
      const classes = await query(
        "SELECT name, stream FROM classes WHERE id = ? LIMIT 1",
        [req.params.id],
      );
      if (!classes.length) return res.redirect("/classes");
      const classValue = classes[0].stream
        ? `${classes[0].name} - ${classes[0].stream}`
        : classes[0].name;
      const enrolled = await query(
        "SELECT COUNT(*) AS count FROM students WHERE class = ?",
        [classValue],
      );
      if (Number(enrolled[0].count) > 0) {
        return res
          .status(409)
          .send("Reassign enrolled students before deleting this class.");
      }
      await query("DELETE FROM classes WHERE id = ?", [req.params.id]);
      res.redirect("/classes");
    } catch (error) {
      console.log("Class deletion error:", error.message);
      res.status(500).send("Could not delete class.");
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

    const [dateRows, availableClasses] = await Promise.all([
      query("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today"),
      query(
        "SELECT DISTINCT class FROM students WHERE class IS NOT NULL AND class <> '' ORDER BY class",
      ),
    ]);
    const today = dateRows[0].today;
    const date = String(req.query.date || today).trim();
    const selectedClass = String(req.query.class || "").trim();
    if (!isValidDate(date)) {
      return res.status(400).send("Choose a valid attendance date.");
    }
    const students = await query(
      `SELECT id, name, admissionNo, class FROM students ${
        selectedClass ? "WHERE class = ?" : ""
      } ORDER BY class, name`,
      selectedClass ? [selectedClass] : [],
    );
    const studentIds = students.map((student) => student.id);
    const records = studentIds.length
      ? await query(
          `SELECT student_id, status FROM attendance WHERE date = ? AND student_id IN (${studentIds
            .map(() => "?")
            .join(", ")})`,
          [date, ...studentIds],
        )
      : [];
    const recordByStudent = Object.fromEntries(
      records.map((record) => [record.student_id, record.status]),
    );
    res.render("attendance", {
      user,
      canManage: true,
      students,
      recordByStudent,
      today,
      date,
      availableClasses,
      selectedClass,
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
    const date = String(req.body.date || "").trim();
    const selectedClass = String(req.body.class || "").trim();
    const validStatuses = ["present", "absent", "late"];
    if (!isValidDate(date)) {
      return res.status(400).send("Choose a valid attendance date.");
    }
    if (
      !statuses ||
      typeof statuses !== "object" ||
      Array.isArray(statuses) ||
      Object.keys(statuses).length === 0 ||
      Object.entries(statuses).some(
        ([studentId, status]) =>
          !/^\d+$/.test(studentId) || !validStatuses.includes(status),
      )
    ) {
      return res.status(400).send("Select a valid attendance status for students.");
    }
    try {
      const studentIds = Object.keys(statuses);
      const validStudents = await query(
        `SELECT id FROM students WHERE id IN (${studentIds
          .map(() => "?")
          .join(", ")})${selectedClass ? " AND class = ?" : ""}`,
        selectedClass ? [...studentIds, selectedClass] : studentIds,
      );
      if (validStudents.length !== studentIds.length) {
        return res
          .status(400)
          .send("Attendance includes a student outside the selected class.");
      }
      for (const [studentId, status] of Object.entries(statuses)) {
        await query(
          "INSERT INTO attendance (student_id, date, status, marked_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = VALUES(status), marked_by = VALUES(marked_by)",
          [studentId, date, status, req.session.user.id],
        );
      }
      const params = new URLSearchParams({ date });
      if (selectedClass) params.set("class", selectedClass);
      res.redirect(`/attendance?${params.toString()}`);
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
        "Subject | Term | Score | Grade",
        ...report.grades.map(
          (grade) => {
            const letterGrade = grade.grade
              || (grade.score == null ? "—" : gradeLabel(Number(grade.score)));
            return `${grade.subject || ""} | ${grade.term || ""} | ${grade.score ?? ""} | ${letterGrade}`;
          },
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
    const termOptions = await getTermOptions();
    const requestedTerm = String(req.query.term || "");
    const selectedTerm = termOptions.includes(requestedTerm)
      ? requestedTerm
      : "";
    const fees = canManage
      ? await query(
          "SELECT fees.*, students.name AS student_name, students.admissionNo, students.class AS student_class FROM fees JOIN students ON students.id = fees.student_id WHERE (? = '' OR fees.term = ?) ORDER BY fees.created_at DESC, students.name",
          [selectedTerm, selectedTerm],
        )
      : user.linked_id
        ? await query(
            "SELECT fees.*, students.name AS student_name, students.admissionNo, students.class AS student_class FROM fees JOIN students ON students.id = fees.student_id WHERE fees.student_id = ? AND (? = '' OR fees.term = ?) ORDER BY fees.created_at DESC",
            [user.linked_id, selectedTerm, selectedTerm],
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
      termOptions,
      selectedTerm,
    });
  } catch (error) {
    console.log("Fees query error:", error.message);
    res.status(500).send("Could not load fees.");
  }
});

app.post("/api/mpesa/stkpush", isAuthenticated, async (req, res) => {
  const user = req.session.user;
  const feeId = String(req.body.feeId || "");
  const amount = Number(req.body.amount);
  const phone = String(req.body.phone || "").replace(/[\s+()-]/g, "");
  if (!["admin", "parent", "student"].includes(user.role)) {
    return res.status(403).json({ configured: false, message: "You cannot request a payment for this account." });
  }
  if (!/^\d+$/.test(feeId) || !Number.isFinite(amount) || amount <= 0 || !/^(?:0|254)\d{9}$/.test(phone)) {
    return res.status(400).json({ configured: false, message: "A valid fee record, amount, and Kenyan phone number are required." });
  }
  try {
    const rows = await query(
      "SELECT fees.id, fees.student_id, fees.balance FROM fees WHERE fees.id = ? LIMIT 1",
      [feeId],
    );
    if (!rows.length) {
      return res.status(404).json({ configured: false, message: "Fee record not found." });
    }
    if (user.role !== "admin" && Number(user.linked_id) !== Number(rows[0].student_id)) {
      return res.status(403).json({ configured: false, message: "You can only request payment for your linked student account." });
    }
    if (amount > Number(rows[0].balance)) {
      return res.status(400).json({ configured: false, message: "Payment exceeds the outstanding balance." });
    }
    return res.status(501).json({
      configured: false,
      message: "Daraja STK Push is not configured. No payment request was sent.",
    });
  } catch (error) {
    console.log("M-Pesa STK placeholder error:", error.message);
    return res.status(500).json({ configured: false, message: "Could not validate this payment request." });
  }
});

app.post(
  "/api/sms/send",
  isAuthenticated,
  authorizeRoles(["admin"]),
  async (req, res) => {
    const studentId = String(req.body.studentId || "");
    if (!/^\d+$/.test(studentId)) {
      return res.status(400).json({ configured: false, message: "A valid student is required." });
    }
    try {
      const students = await query(
        "SELECT students.id, students.parentContact, COALESCE(SUM(fees.balance), 0) AS balance FROM students LEFT JOIN fees ON fees.student_id = students.id WHERE students.id = ? GROUP BY students.id, students.parentContact LIMIT 1",
        [studentId],
      );
      if (!students.length) {
        return res.status(404).json({ configured: false, message: "Student not found." });
      }
      if (!students[0].parentContact) {
        return res.status(400).json({ configured: false, message: "No parent contact is on file for this student." });
      }
      return res.status(501).json({
        configured: false,
        message: "SMS delivery is not configured. No message was sent.",
        balance: Number(students[0].balance) || 0,
      });
    } catch (error) {
      console.log("SMS placeholder error:", error.message);
      return res.status(500).json({ configured: false, message: "Could not prepare the balance message." });
    }
  },
);

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
        "SELECT id, balance FROM fees WHERE student_id = ? AND term = ? ORDER BY id LIMIT 1",
        [studentId, term],
      );
      if (existing.length) {
        if (amount > Number(existing[0].balance)) {
          return res.status(400).send("Payment exceeds the outstanding balance.");
        }
        const updateResult = await query(
          "UPDATE fees SET paid_amount = paid_amount + ?, payment_method = ?, mpesa_code = ? WHERE id = ? AND balance >= ?",
          [amount, paymentMethod, mpesaCode || null, existing[0].id, amount],
        );
        if (updateResult.affectedRows !== 1) {
          return res.status(400).send("Payment exceeds the outstanding balance.");
        }
      } else {
        if (amount > 15000) {
          return res
            .status(400)
            .send("Payment exceeds the default term fee of 15,000.");
        }
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
  async (req, res) => {
    try {
      res.render("add_student", {
        user: req.session.user,
        classOptions: await getClassOptions(),
      });
    } catch (error) {
      console.log("Student form class query error:", error.message);
      res.status(500).send("Could not load student form.");
    }
  },
);
app.get(
  "/add_student",
  isAuthenticated,
  authorizeRoles(["admin", "teacher"]),
  (req, res) => res.redirect("/students/add"),
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
  async (req, res) => {
    try {
      const [students, classOptions] = await Promise.all([
        query("SELECT * FROM students WHERE id = ?", [req.params.id]),
        getClassOptions(),
      ]);
      if (!students.length) return res.redirect("/students");
      res.render("edit_student", {
        user: req.session.user,
        student: students[0],
        classOptions,
      });
    } catch (error) {
      console.log("Student edit query error:", error.message);
      res.status(500).send("Could not load student.");
    }
  },
);

app.post(
  "/students/edit/:id",
  isAuthenticated,
  authorizeRoles(["admin", "teacher"]),
  async (req, res) => {
    const {
      name,
      admissionNo,
      class: className,
      parentContact,
      admission_no,
      parent_phone,
    } = req.body;

    const finalAdmissionNo = admissionNo || admission_no;
    const finalContact = parentContact || parent_phone;

    try {
      const sql =
        "UPDATE students SET name = ?, admissionNo = ?, class = ?, parentContact = ? WHERE id = ?";
      await query(sql, [name, finalAdmissionNo, className, finalContact, req.params.id]);
      res.redirect("/students");
    } catch (error) {
      console.log("Student update error:", error.message);
      res.status(500).send("Could not update student.");
    }
  },
);

app.get(
  "/students/delete/:id",
  isAuthenticated,
  authorizeRoles(["admin", "teacher"]),
  async (req, res) => {
    try {
      await query("DELETE FROM students WHERE id = ?", [req.params.id]);
      res.redirect("/students");
    } catch (error) {
      console.log("Student delete error:", error.message);
      res.status(500).send("Could not delete student.");
    }
  },
);

app.post(
  "/students/delete/:id",
  isAuthenticated,
  authorizeRoles(["admin", "teacher"]),
  async (req, res) => {
    try {
      await query("DELETE FROM students WHERE id = ?", [req.params.id]);
      res.redirect("/students");
    } catch (error) {
      console.log("Student delete error:", error.message);
      res.status(500).send("Could not delete student.");
    }
  },
);

app.use((req, res) => {
  res.status(404).render("404");
});

// The database connection and migrations are initialized before serving requests.
