USE students_db;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100),
  email VARCHAR(100) UNIQUE,
  password VARCHAR(255),
  role ENUM('admin','teacher','parent','student') NOT NULL,
  linked_id INT NULL,
  subject VARCHAR(100) NULL,
  qualification VARCHAR(100) NULL,
  tsc_no VARCHAR(50) NULL
);

CREATE TABLE IF NOT EXISTS students (
  id INT AUTO_INCREMENT PRIMARY KEY,
  admissionNo VARCHAR(20),
  name VARCHAR(100),
  class VARCHAR(50),
  parentContact VARCHAR(20)
  ,UNIQUE KEY uq_students_admissionNo (admissionNo)
);

CREATE TABLE IF NOT EXISTS teachers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100),
  subject VARCHAR(50),
  qualification VARCHAR(100)
  ,tscNo VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS classes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50),
  stream VARCHAR(50),
  teacherName VARCHAR(100)
);

CREATE TABLE IF NOT EXISTS attendance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT NOT NULL,
  date DATE NOT NULL,
  status ENUM('present','absent','late') NOT NULL DEFAULT 'present',
  marked_by INT NULL,
  UNIQUE KEY uq_attendance_student_date (student_id, date)
);

CREATE TABLE IF NOT EXISTS grades (
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT,
  course_id INT NULL,
  subject VARCHAR(50),
  term VARCHAR(20),
  score INT,
  grade VARCHAR(2) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users MODIFY role ENUM('admin','teacher','parent','student') NOT NULL;
ALTER TABLE users ADD COLUMN linked_id INT NULL;
ALTER TABLE users ADD COLUMN subject VARCHAR(100) NULL;
ALTER TABLE users ADD COLUMN qualification VARCHAR(100) NULL;
ALTER TABLE users ADD COLUMN tsc_no VARCHAR(50) NULL;
ALTER TABLE grades MODIFY course_id INT NULL;
ALTER TABLE grades ADD COLUMN subject VARCHAR(50) NULL;
ALTER TABLE grades ADD COLUMN term VARCHAR(20) NULL;
ALTER TABLE grades ADD COLUMN grade VARCHAR(2) NULL;
ALTER TABLE grades ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS fees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT,
  term VARCHAR(20),
  total_amount DECIMAL(10,2) DEFAULT 15000,
  paid_amount DECIMAL(10,2) DEFAULT 0,
  balance DECIMAL(10,2) GENERATED ALWAYS AS (total_amount - paid_amount) STORED,
  payment_method ENUM('cash','mpesa','bank') NULL,
  mpesa_code VARCHAR(20) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id)
);