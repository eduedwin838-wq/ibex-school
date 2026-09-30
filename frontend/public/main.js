const express = require("express");
const mysql = require("mysql2");
const session = require("express-session");
const path = require("path");
const bcrypt = require("bcrypt");

const app = express();
const PORT = 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(
  session({ secret: "ibexsecret", resave: false, saveUninitialized: true }),
);

const dbConnection = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "Eduedwin@74",
  database: "students_db",
});

dbConnection.connect((err) => {
  if (err) {
    console.log("DB CONNECTION ERROR:", err);
    return;
  }
  console.log("Connected to the MySQL database.");
});

function isLoggedIn(req, res, next) {
  if (req.session.user) return next();
  res.redirect("/login");
}

app.get("/login", (req, res) =>
  res.render("login", { error: null, registered: false }),
);
app.post("/login", (req, res) => {
  req.session.user = { name: req.body.username || req.body.email };
  res.redirect("/students");
});

app.get("/dashboard", isLoggedIn, (req, res) =>
  res.render("dashboard", { user: req.session.user }),
);

app.get("/students", isLoggedIn, (req, res) => {
  dbConnection.query(
    "SELECT * FROM students ORDER BY id DESC",
    (err, results) => {
      if (err) return res.send("DB Error: " + err.sqlMessage);
      res.render("students", { students: results, user: req.session.user });
    },
  );
});

app.get("/students/add", isLoggedIn, (req, res) =>
  res.render("add_student", { user: req.session.user }),
);

app.post("/students/add", isLoggedIn, (req, res) => {
  const { name, admissionNo, class: student_class, parentContact } = req.body;
  const sql =
    "INSERT INTO students (name, admissionNo, class, parentContact) VALUES (?,?,?,?)";
  dbConnection.query(
    sql,
    [name, admissionNo, student_class, parentContact],
    (err) => {
      if (err)
        return res.send(
          "DB ERROR: " + err.sqlMessage + " <a href='/students/add'>Back</a>",
        );
      res.redirect("/students");
    },
  );
});

app.get("/students/edit/:id", isLoggedIn, (req, res) => {
  dbConnection.query(
    "SELECT * FROM students WHERE id =?",
    [req.params.id],
    (err, results) => {
      if (err) return res.send("DB Error: " + err.sqlMessage);
      if (results.length === 0) return res.send("Student not found");
      res.render("edit_student", {
        student: results[0],
        user: req.session.user,
      });
    },
  );
});

app.post("/students/edit/:id", isLoggedIn, (req, res) => {
  const { name, admissionNo, class: student_class, parentContact } = req.body;
  const sql =
    "UPDATE students SET name=?, admissionNo=?, class=?, parentContact=? WHERE id=?";
  dbConnection.query(
    sql,
    [name, admissionNo, student_class, parentContact, req.params.id],
    (err) => {
      if (err) return res.send("DB Error: " + err.sqlMessage);
      res.redirect("/students");
    },
  );
});

app.get("/students/delete/:id", isLoggedIn, (req, res) => {
  dbConnection.query(
    "DELETE FROM students WHERE id=?",
    [req.params.id],
    (err) => {
      if (err) return res.send("Delete Error: " + err.sqlMessage);
      res.redirect("/students");
    },
  );
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});
app.get("/", (req, res) => {
  res.redirect("/login");
});

app.get("/register", (req, res) => {
  res.render("register", { error: null });
});

app.post("/register", async (req, res) => {
  const { username, email, password, role } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  const sql =
    "INSERT INTO users (name, email, password, role) VALUES (?,?,?,?)";
  dbConnection.query(sql, [username, email, hashedPassword, role], (err) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY")
        return res.render("register", { error: "Name or Email already taken" });
      return res.send("DB Error: " + err.sqlMessage);
    }
    res.redirect("/login");
  });
});

app.listen(PORT, () =>
  console.log(`Server is running on http://localhost:${PORT}`),
);
