// index.js
require("dotenv").config();
const morgan = require('morgan');
const express = require('express');
const app = express();
const router = express.Router();

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(morgan('combined'));
app.use('/reserve', router);

// Routes
router.post('/01BLUE', async (req, res) => await reserve(req.body, res, '01BLUE'));
router.post('/02GRAY', async (req, res) => await reserve(req.body, res, '02GRAY'));
router.post('/03SILVER', async (req, res) => await reserve(req.body, res, '03SILVER'));
router.post('/04GOLD', async (req, res) => await reserve(req.body, res, '04GOLD'));
router.post('/GLAB1', async (req, res) => await reserve(req.body, res, 'GLAB1'));
router.post('/GLAB2', async (req, res) => await reserve(req.body, res, 'GLAB2'));

router.post('/CHARGER01', async (req, res) => await reserveCharger(req.body, res, '노트북 충전기 (C-Type 65W)'));
router.post('/CHARGER02', async (req, res) => await reserveCharger(req.body, res, '스마트폰 충전기 (C-Type)'));
router.post('/CHARGER03', async (req, res) => await reserveCharger(req.body, res, '아이폰 충전기 (8pin)'));

router.post('/check/start_time', async (req, res) => await reserveStartTimeCheck(req.body, res));
router.post('/check/client_info', async (req, res) => await reserveClientInfoCheck(req.body, res));
router.post('/cancel', async (req, res) => await reserveCancel(req.body, res));
router.post('/check/reserve_code', async (req, res) => await reserveCodeCheck(req.body, res));

router.head('/wakeup', async (req, res) => { res.status(200).send(); });

// ------------------------------------------------------
// 1) 절대 수정 금지: 기존 'reserve' 함수 (방/GLAB 예약)
// ------------------------------------------------------
async function reserve(reqBody, res, room_type) {
  const start_time_str = JSON.parse(reqBody.action.params.start_time).value;
  const end_time_str = JSON.parse(reqBody.action.params.end_time).value;
  const client_info = parseClientInfo(reqBody.action.params.client_info);
  const kakao_id = reqBody.userRequest.user.id;
  
  // KST 기준 현재 시간 확인
  const now = new Date();
  now.setHours(now.getHours() + 9); // UTC → KST 변환

  // start_time, end_time을 KST DATETIME 형식으로 변환
  const todayDate = now.toISOString().split('T')[0]; // YYYY-MM-DD 포맷
  const start_time = `${todayDate} ${start_time_str}:00`;
  const end_time = `${todayDate} ${end_time_str}:00`;
  const time_string = `${start_time_str} - ${end_time_str}`;

  let table;
  if (['01BLUE', '02GRAY', '03SILVER', '04GOLD'].includes(room_type)) {
    table = 'new_media_library';
  } else if (['GLAB1', 'GLAB2'].includes(room_type)) {
    table = 'glab';
  } else {
    return res.send({ status: "FAIL", message: "잘못된 방 유형입니다." });
  }

  if (isAvailableTime()) {
    return res.send({
      "version": "2.0",
      "template": {
        "outputs": [{ "textCard": { "title": "현재 예약할 수 없는 시간입니다.", "description": "평일 9시부터 22시까지 당일 예약만 가능합니다." } }]
      }
    });
  }

  if (isWrongHours(start_time, end_time)) {
    return res.send({
      "version": "2.0",
      "template": {
        "outputs": [{ "textCard": { "title": "30분부터 최대 4시간까지 신청 가능합니다.", "description": `- 방 종류: ${room_type}\n- 신청한 시간: ${time_string}\n\n처음부터 다시 시도해주세요. 종료 시각이 시작 시각 이전으로 작성되었는지 확인해주세요.` } }]
      }
    });
  }

  if (await checkOverlap(table, start_time, end_time, room_type)) {
    return res.send({
      "version": "2.0",
      "template": {
        "outputs": [{ "textCard": { "title": "해당 일시에 겹치는 예약이 있습니다.", "description": `- 방 종류: ${room_type}\n- 신청한 시간: ${time_string}\n\n예약 현황을 조회하시고, 비어있는 시간에 다시 신청해주세요.` } }]
      }
    });
  }

  const reserve_code = await generateReserveCode(room_type);
  const hiddenName = hideMiddleChar(client_info.name);

  await addToDatabase(table, reserve_code, room_type, start_time, end_time, hiddenName, client_info, kakao_id);

  return res.send({
    "version": "2.0",
    "template": {
      "outputs": [{
        "textCard": {
          "title": "성공적으로 예약되었습니다.",
          "description": `- 방 종류: ${room_type}\n- 예약 번호: ${reserve_code}\n- 대여 시간: ${time_string}\n- 신청자: ${hiddenName}`
        }
      }]
    }
  });
}

// ------------------------------------------------------
// 2) 충전기 예약 함수 (reserveCharger) - MySQL & 로그 보강
// ------------------------------------------------------
async function reserveCharger(reqBody, res, type) {
  console.log("[INFO] Calling reserveCharger...");
  try {
    const start_time_str = JSON.parse(reqBody.action.params.start_time).value;
    const end_time_str = JSON.parse(reqBody.action.params.end_time).value;
    const client_info = parseClientInfo(reqBody.action.params.client_info);
    const kakao_id = reqBody.userRequest.user.id;
    const time_string = `${start_time_str.slice(0, 5)} - ${end_time_str.slice(0, 5)}`;

    console.log("[DEBUG] Charger type:", type);
    console.log("[DEBUG] start_time_str:", start_time_str, "end_time_str:", end_time_str);
    console.log("[DEBUG] client_info:", client_info);

    // KST 기준 현재 시간 확인
    const now = new Date();
    now.setHours(now.getHours() + 9);
    const todayDate = now.toISOString().split('T')[0];
    const start_time = `${todayDate} ${start_time_str}:00`;
    const end_time = `${todayDate} ${end_time_str}:00`;

    // 충전기는 'charger' 테이블 사용
    const table = 'charger';

    // 1) 학생회비 납부자 여부 체크
    if (await isNotPayer(client_info.name, client_info.id)) {
      const description = `- 이름: ${client_info.name}\n- 학번: ${client_info.id}\n2024학년도 1학기 예술공학대학 학생회비 납부자가 아닙니다. 정보를 제대로 입력하였는지 확인해주시고, 학생회 채널로 문의 바랍니다.`;
      console.log("[WARN] Not a payer ->", client_info.name, client_info.id);
      res.send({
        "version": "2.0",
        "template": {
          "outputs": [
            {
              "textCard": {
                "title": "학생회비 납부자가 아닙니다.",
                "description": description,
                "buttons": [{ "label": "처음으로", "action": "block", "messageText": "처음으로" }]
              }
            }
          ]
        }
      });
      return;
    }

    // 2) 사용 가능 시간 확인
    if (isAvailableTime()) {
      const description = `평일 9시부터 22시까지 당일 예약만 가능합니다.`;
      console.log("[WARN] Not available time -> hour or day not valid");
      res.send({
        "version": "2.0",
        "template": {
          "outputs": [
            {
              "textCard": {
                "title": "현재 예약할 수 없는 시간입니다.",
                "description": description,
                "buttons": [{ "label": "처음으로", "action": "block", "messageText": "처음으로" }]
              }
            }
          ]
        }
      });
      return;
    }

    // 3) 30분 ~ 최대 4시간 범위 체크
    if (isWrongHours(start_time_str, end_time_str)) {
      const description = `- 충전기 종류: ${type}\n- 신청한 시간: ${time_string}\n\n처음부터 다시 시도해주세요. 종료 시각이 시작 시각 이전으로 작성되었는지 확인해주세요.`;
      console.log("[WARN] Wrong hours -> start_time >= end_time or over 4 hours");
      res.send({
        "version": "2.0",
        "template": {
          "outputs": [
            {
              "textCard": {
                "title": "30분부터 최대 4시간까지 신청 가능합니다.",
                "description": description,
                "buttons": [{ "label": "처음으로", "action": "block", "messageText": "처음으로" }]
              }
            }
          ]
        }
      });
      return;
    }

    // 4) 중복 여부
    if (await checkOverlap(table, start_time, end_time, `${type} 1`)) {
      console.log("[DEBUG] Overlap with (type 1) -> checking (type 2) ...");
      if (await checkOverlap(table, start_time, end_time, `${type} 2`)) {
        // "type 1" / "type 2" 전부 겹침
        const description = `- 충전기 종류: ${type}\n- 신청한 시간: ${time_string}\n\n예약 현황을 조회하시고, 비어있는 시간에 다시 신청해주세요.`;
        console.log("[WARN] All chargers overlapped");
        res.send({
          "version": "2.0",
          "template": {
            "outputs": [
              {
                "textCard": {
                  "title": "모든 충전기가 사용중입니다.",
                  "description": description,
                  "buttons": [{ "label": "처음으로", "action": "block", "messageText": "처음으로" }]
                }
              }
            ]
          }
        });
        return;
      } else {
        // "type 1"만 겹치고, "type 2"는 가능
        console.log("[INFO] Charger type 2 is available");
        const reserve_code = await generateReserveCode('CHARGER');
        const hiddenName = hideMiddleChar(client_info.name);
        const locker_password = await getLockertPassword(`${type} 2`);
        const description = `- 충전기 종류: ${type} 2\n- 사물함 비밀번호: ${locker_password}\n- 예약 번호: ${reserve_code}\n- 대여 시간: ${time_string}\n- 신청자: ${hiddenName}\n\n사용 후 제 자리에 돌려놔주시길 바랍니다. 안내 및 준수 사항 미확인으로 생기는 문제는 책임지지 않으며, 추후 대여가 제한될 수 있습니다.`;

        res.send({
          "version": "2.0",
          "template": {
            "outputs": [
              {
                "textCard": {
                  "title": "성공적으로 대여하였습니다.",
                  "description": description,
                  "buttons": [{ "label": "처음으로", "action": "block", "messageText": "처음으로" }]
                }
              }
            ]
          }
        });
        // DB에 기록
        await addToDatabaseCharger(table, reserve_code, `${type} 2`, start_time, end_time, hiddenName, client_info, kakao_id);
        console.log("[SUCCESS] Completed reserveCharger with code:", reserve_code);
        return;
      }
    }

    // "type 1"이 예약 가능
    console.log("[INFO] Charger type 1 is available");
    const reserve_code = await generateReserveCode('CHARGER');
    const hiddenName = hideMiddleChar(client_info.name);
    const locker_password = await getLockertPassword(`${type} 1`);
    const description = `- 충전기 종류: ${type} 1\n- 사물함 비밀번호: ${locker_password}\n- 예약 번호: ${reserve_code}\n- 대여 시간: ${time_string}\n- 신청자: ${hiddenName}\n\n사용 후 제 자리에 돌려놔주시길 바랍니다. 안내 및 준수 사항 미확인으로 생기는 문제는 책임지지 않으며, 추후 대여가 제한될 수 있습니다.`;
    
    res.send({
      "version": "2.0",
      "template": {
        "outputs": [
          {
            "textCard": {
              "title": "성공적으로 대여하였습니다.",
              "description": description,
              "buttons": [{ "label": "처음으로", "action": "block", "messageText": "처음으로" }]
            }
          }
        ]
      }
    });
    // DB에 기록
    await addToDatabaseCharger(table, reserve_code, `${type} 1`, start_time, end_time, hiddenName, client_info, kakao_id);
    console.log("[SUCCESS] Completed reserveCharger with code:", reserve_code);
    return;

  } catch (error) {
    console.error("[ERROR] reserveCharger:", error);
    return res.send({ "status": "FAIL", "message": "충전기 예약 중 오류가 발생했습니다." });
  }
}

// ------------------------------------------------------
// 충전기 예약 정보를 DB에 삽입 & 로그 기록
// ------------------------------------------------------
async function addToDatabaseCharger(table, reserve_code, charger_type, start_time, end_time, masked_name, client_info, kakao_id) {
  console.log("[INFO] addToDatabaseCharger ->", charger_type, reserve_code);
  const connection = await pool.getConnection();
  try {
    // 1) charger 테이블 삽입
    const query = `INSERT INTO ${table} (reserve_code, charger_type, start_time, end_time, masked_name) VALUES (?, ?, ?, ?, ?)`;
    console.log("[DEBUG] charger insert query:", query);
    await connection.execute(query, [reserve_code, charger_type, start_time, end_time, masked_name]);

    // 2) logs 테이블에도 기록 추가
    const logQuery = `
      INSERT INTO logs (reserve_code, room_type, request_type, name, student_id, phone, kakao_id)
      VALUES (?, ?, 'reserve', ?, ?, ?, ?)
    `;
    // room_type 칼럼에 "노트북 충전기 (C-Type 65W) 1" 등으로 그대로 삽입
    console.log("[DEBUG] logs insert query:", logQuery);
    await connection.execute(logQuery, [reserve_code, charger_type, client_info.name, client_info.id, client_info.phone, kakao_id]);

  } catch (err) {
    console.error("[ERROR] addToDatabaseCharger:", err);
    throw err;
  } finally {
    connection.release();
  }
}

// ------------------------------------------------------
// 3) 예약 취소 함수 (reserveCancel) - MySQL & 로그 보강
// ------------------------------------------------------
async function reserveCancel(reqBody, res) {
  console.log("[INFO] Calling reserveCancel...");
  try {
    const reserve_code = reqBody.action.params.reserve_code;
    const kakao_id = reqBody.userRequest.user.id;
    console.log("[DEBUG] reserve_code:", reserve_code, "kakao_id:", kakao_id);

    // 1) logs에서 존재하는 'reserve' 요청인지 확인
    const connection = await pool.getConnection();
    let logRow;
    try {
      const query = `
        SELECT * FROM logs
        WHERE reserve_code = ? AND request_type = 'reserve'
      `;
      console.log("[DEBUG] cancel-check query:", query);
      const [rows] = await connection.execute(query, [reserve_code]);

      if (rows.length === 0) {
        console.log(`[FAILED] Reservation code that does not exist : ${reserve_code}`);
        const description = `다시 시도해주세요.`;
        res.send({
          "version": "2.0",
          "template": {
            "outputs": [
              {
                "textCard": {
                  "title": "예약번호와 일치하는 예약이 없습니다",
                  "description": description,
                  "buttons": [{ "label": "처음으로", "action": "block", "messageText": "처음으로" }]
                }
              }
            ]
          }
        });
        return;
      }

      // 예약자(kakao_id) 확인
      logRow = rows[0];
      if (logRow.kakao_id !== kakao_id) {
        console.log(`[FAILED] Reservation by another person : ${reserve_code}`);
        const description = `신청자의 카카오톡 계정으로 취소를 진행해주세요.`;
        res.send({
          "version": "2.0",
          "template": {
            "outputs": [
              {
                "textCard": {
                  "title": "신청자 본인이 아닙니다",
                  "description": description,
                  "buttons": [{ "label": "처음으로", "action": "block", "messageText": "처음으로" }]
                }
              }
            ]
          }
        });
        return;
      }
    } finally {
      connection.release();
    }

    // 2) 실제 예약 테이블에서 삭제
    let table;
    const codeFirst = reserve_code[0]; // '1','2','3','4','5','6','7'...
    if (['1','2','3','4'].includes(codeFirst)) {
      table = 'new_media_library';
    } else if (['5','6'].includes(codeFirst)) {
      table = 'glab';
    } else if (['7'].includes(codeFirst)) {
      table = 'charger';
    } else {
      table = '';
    }

    if (!table) {
      console.log(`[FAILED] Unknown reservation code prefix : ${reserve_code}`);
      const description = `다시 시도해주세요.`;
      return res.send({
        "version": "2.0",
        "template": {
          "outputs": [
            {
              "textCard": {
                "title": "잘못된 예약코드입니다",
                "description": description,
                "buttons": [{ "label": "처음으로", "action": "block", "messageText": "처음으로" }]
              }
            }
          ]
        }
      });
    }

    const conn2 = await pool.getConnection();
    try {
      const checkQuery = `SELECT * FROM ${table} WHERE reserve_code = ?`;
      console.log("[DEBUG] checking table row before delete:", checkQuery);
      const [checkRows] = await conn2.execute(checkQuery, [reserve_code]);

      if (checkRows.length === 0) {
        console.log(`[FAILED] Reservation already cancelled : ${reserve_code}`);
        const description = `다시 시도해주세요.`;
        res.send({
          "version": "2.0",
          "template": {
            "outputs": [
              {
                "textCard": {
                  "title": "이미 취소된 예약입니다",
                  "description": description,
                  "buttons": [{ "label": "처음으로", "action": "block", "messageText": "처음으로" }]
                }
              }
            ]
          }
        });
        return;
      }

      // 예약 삭제
      const delQuery = `DELETE FROM ${table} WHERE reserve_code = ?`;
      console.log("[DEBUG] deleting row:", delQuery);
      await conn2.execute(delQuery, [reserve_code]);

      // logs 테이블에 cancel 추가
      const insertLog = `
        INSERT INTO logs (reserve_code, room_type, request_type, name, student_id, phone, kakao_id)
        VALUES (?, ?, 'cancel', ?, ?, ?, ?)
      `;
      console.log("[DEBUG] inserting cancel log:", insertLog);
      await conn2.execute(insertLog, [
        logRow.reserve_code,
        logRow.room_type,
        logRow.name,
        logRow.student_id,
        logRow.phone,
        logRow.kakao_id
      ]);

      const originRow = checkRows[0];
      // ex) "2023-12-15 15:00:00" -> substring(11,16) = "15:00"
      const time_string = originRow.start_time.substring(11,16) + ' - ' + originRow.end_time.substring(11,16); 
      const hiddenName = originRow.masked_name;
      const description = `- ${logRow.room_type}\n- 예약 번호: ${reserve_code}\n- 대여 시간: ${time_string}\n- 신청자: ${hiddenName}`;

      res.send({
        "version": "2.0",
        "template": {
          "outputs": [
            {
              "textCard": {
                "title": "대여를 취소했습니다",
                "description": description,
                "buttons": [{ "label": "처음으로", "action": "block", "messageText": "처음으로" }]
              }
            }
          ]
        }
      });
      console.log("[SUCCESS] Completed reserveCancel for:", reserve_code);

    } finally {
      conn2.release();
    }

  } catch (error) {
    console.error("[ERROR] reserveCancel:", error);
    return res.send({ "status": "FAIL", "message": "예약 취소 중 오류가 발생했습니다." });
  }
}

// ------------------------------------------------------
// 4) 유효성 검사 API들 (MySQL 사용 or 단순 검증) + 로그 추가
// ------------------------------------------------------
async function reserveStartTimeCheck(reqBody, res) {
  console.log("[INFO] reserveStartTimeCheck called.");
  try {
    const start_time_str = reqBody.value.origin.slice(0, 5); // "HH:MM" 형식 추출
    const startTime = timeStringToArray(start_time_str);
    const currentTime = getCurrentTime();
    const intervalInMinutes = getTimeInterval(currentTime, startTime);

    if (intervalInMinutes < -30) {
      console.log(`[FAILED] Not available for 30 min ago : ${start_time_str}`);
      return res.send({ "status": "FAIL", "message": "30분 전 시간은 예약할 수 없습니다." });
    }

    console.log(`[SUCCESS] Successfully Validated : ${start_time_str}`);
    return res.send({ "status": "SUCCESS" });
  } catch (error) {
    console.error(`[ERROR] reserveStartTimeCheck: ${error}`);
    return res.send({ "status": "FAIL", "message": "잘못된 요청입니다." });
  }
}

async function reserveClientInfoCheck(reqBody, res) {
  console.log("[INFO] reserveClientInfoCheck called.");
  try {
    const str = reqBody.value.origin;
    const cleaned = str.replace(/[\s-]/g, '');
    const parts = cleaned.split(',');

    if (parts.length !== 3) {
      console.log(`[FAILED] Invalid client info format: ${str}`);
      return res.send({ "status": "FAIL", "message": "이름, 학번, 전화번호를 올바르게 입력해주세요." });
    }

    const name = parts[0];
    const student_id = parts[1];
    const phone = parts[2];

    // 학번: 8자리 숫자, 전화번호: 11자리 숫자인지 확인
    const studentIdPattern = /^\d{8}$/;
    const phonePattern = /^\d{11}$/;

    if (!name || name.length < 1) {
      console.log(`[FAILED] Invalid name: ${name}`);
      return res.send({ "status": "FAIL", "message": "이름을 올바르게 입력해주세요." });
    }

    if (!studentIdPattern.test(student_id)) {
      console.log(`[FAILED] Invalid student ID: ${student_id}`);
      return res.send({ "status": "FAIL", "message": "학번은 8자리 숫자로 입력해주세요." });
    }

    if (!phonePattern.test(phone)) {
      console.log(`[FAILED] Invalid phone number: ${phone}`);
      return res.send({ "status": "FAIL", "message": "전화번호는 11자리 숫자로 입력해주세요." });
    }

    console.log(`[SUCCESS] Successfully Validated: ${name}, ${student_id}, ${phone}`);
    return res.send({ "status": "SUCCESS" });

  } catch (error) {
    console.error(`[ERROR] reserveClientInfoCheck: ${error}`);
    return res.send({ "status": "FAIL", "message": "잘못된 요청입니다." });
  }
}

async function reserveCodeCheck(reqBody, res) {
  console.log("[INFO] reserveCodeCheck called.");
  try {
    const reserve_code = reqBody.value.origin;

    if (!/^\d{6}$/.test(reserve_code)) {
      console.log(`[FAILED] Invalid reserve code format: ${reserve_code}`);
      return res.send({ "status": "FAIL", "message": "올바른 형식의 예약 코드가 아닙니다." });
    }

    const connection = await pool.getConnection();
    try {
      const query = `SELECT * FROM logs WHERE reserve_code = ?`;
      console.log("[DEBUG] Checking code in logs ->", query);
      const [rows] = await connection.execute(query, [reserve_code]);

      if (rows.length === 0) {
        console.log(`[FAILED] Reservation code not found: ${reserve_code}`);
        return res.send({ "status": "FAIL", "message": "존재하지 않는 예약 코드입니다." });
      }

      console.log(`[SUCCESS] Successfully Validated: ${reserve_code}`);
      return res.send({ "status": "SUCCESS" });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error(`[ERROR] reserveCodeCheck: ${error}`);
    return res.send({ "status": "FAIL", "message": "잘못된 요청입니다." });
  }
}

// ------------------------------------------------------
// 5) 공통 함수들 (Overlap 체크, DB Insert 등) + 로그 추가
// ------------------------------------------------------
function timeStringToArray(timeString) {
  const splitString = timeString.split(":");
  return splitString.map(timePart => parseInt(timePart, 10));
}

function getCurrentTime() {
  const now = new Date();
  now.setHours(now.getUTCHours() + 9);
  return [now.getHours(), now.getMinutes()];
}

function getTimeInterval(timeArray1, timeArray2) {
  const time1InMinutes = timeArray1[0] * 60 + timeArray1[1];
  const time2InMinutes = timeArray2[0] * 60 + timeArray2[1];
  return time2InMinutes - time1InMinutes;
}

function parseClientInfo(str) {
  const cleaned = str.replace(/[\s-]/g, '');
  const parts = cleaned.split(',');
  return { name: parts[0], id: parts[1], phone: parts[2] };
}

function hideMiddleChar(str) {
  if (str.length < 3) return str[0] + '*';
  return str[0] + '*'.repeat(str.length - 2) + str[str.length - 1];
}

// 예약 중복 체크
async function checkOverlap(table, start_time, end_time, room_type) {
  console.log("[INFO] checkOverlap -> table:", table, "room_type:", room_type);
  const connection = await pool.getConnection();
  try {
    const query = `
      SELECT * FROM ${table}
      WHERE 
        (room_type = ? OR charger_type = ?) 
        AND (
          (start_time <= ? AND end_time > ?) OR
          (start_time < ? AND end_time >= ?) OR
          (start_time >= ? AND end_time <= ?)
        )
    `;
    console.log("[DEBUG] overlap query:", query);
    const [rows] = await connection.execute(query, [
      room_type, room_type,
      start_time, start_time,
      end_time, end_time,
      start_time, end_time
    ]);
    console.log("[DEBUG] overlap result count:", rows.length);
    return rows.length > 0;
  } catch (err) {
    console.error("[ERROR] checkOverlap:", err);
    return false; // 혹은 에러 던지기
  } finally {
    connection.release();
  }
}

// 방/공간 예약 정보 DB에 추가
async function addToDatabase(table, reserve_code, room_type, start_time, end_time, masked_name, client_info, kakao_id) {
  console.log("[INFO] addToDatabase ->", table, reserve_code);
  const connection = await pool.getConnection();
  try {
    // 예약 정보 삽입
    const query = `INSERT INTO ${table} (reserve_code, room_type, start_time, end_time, masked_name) VALUES (?, ?, ?, ?, ?)`;
    console.log("[DEBUG] addToDatabase query:", query);
    await connection.execute(query, [reserve_code, room_type, start_time, end_time, masked_name]);

    // logs 테이블에 기록 추가
    const logQuery = `
      INSERT INTO logs (reserve_code, room_type, request_type, name, student_id, phone, kakao_id)
      VALUES (?, ?, 'reserve', ?, ?, ?, ?)
    `;
    console.log("[DEBUG] addToDatabase logs query:", logQuery);
    await connection.execute(logQuery, [reserve_code, room_type, client_info.name, client_info.id, client_info.phone, kakao_id]);

  } catch (err) {
    console.error("[ERROR] addToDatabase:", err);
    throw err;
  } finally {
    connection.release();
  }
}

function isWrongHours(start_time, end_time) {
  const [sh, sm] = start_time.split(':').map(Number);
  const [eh, em] = end_time.split(':').map(Number);
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;
  return (endMinutes - startMinutes) > 240 || (endMinutes - startMinutes) <= 0;
}

function isAvailableTime() {
  const now = new Date();
  now.setHours(now.getHours() + 9); // UTC → KST 변환
  const hour = now.getHours();
  const day = now.getDay(); // 0: 일요일, 1: 월요일, ..., 6: 토요일
  // 평일(월~금) 09:00 ~ 22:00 사이만 예약 가능
  return day < 1 || day > 5 || hour < 9 || hour >= 22;
}

// 학생회비 납부자 여부 (MySQL)
async function isNotPayer(name, id) {
  console.log("[INFO] isNotPayer check ->", name, id);
  const connection = await pool.getConnection();
  try {
    const query = `SELECT * FROM payers WHERE student_id = ? AND name = ?`;
    console.log("[DEBUG] isNotPayer query:", query);
    const [rows] = await connection.execute(query, [id, name]);
    console.log("[DEBUG] payer rows found:", rows.length);
    // 단 한 건도 없으면 '납부자 아님(true)'
    return rows.length === 0;
  } catch (err) {
    console.error("[ERROR] isNotPayer:", err);
    // 오류 시 납부자 아님(true)으로 처리하거나 throw
    return true;
  } finally {
    connection.release();
  }
}

// 충전기 사물함 비밀번호 조회 (MySQL)
async function getLockertPassword(type) {
  console.log("[INFO] getLockertPassword ->", type);
  const connection = await pool.getConnection();
  try {
    const query = `SELECT password FROM charger_lockers WHERE charger_type = ?`;
    console.log("[DEBUG] getLockertPassword query:", query);
    const [rows] = await connection.execute(query, [type]);
    if (rows.length === 0) {
      console.log("[WARN] No locker password found for:", type);
      return '0000'; // 기본값
    }
    console.log("[DEBUG] Found locker password for:", type);
    return rows[0].password;
  } catch (err) {
    console.error("[ERROR] getLockertPassword:", err);
    return '0000'; // 에러 시 기본값
  } finally {
    connection.release();
  }
}

// 예약 코드 생성
async function generateReserveCode(room_type) {
  console.log("[INFO] generateReserveCode ->", room_type);
  const room_codes = {
    '01BLUE': '1', '02GRAY': '2', '03SILVER': '3', '04GOLD': '4',
    'GLAB1': '5', 'GLAB2': '6',
    // CHARGER는 '7'
  };
  const prefix = room_type === 'CHARGER' ? '7' : (room_codes[room_type] || '9');

  const connection = await pool.getConnection();
  try {
    // logs에서 room_type LIKE prefix + '%' AND request_type='reserve'
    const query = `SELECT COUNT(*) AS count FROM logs WHERE room_type LIKE ? AND request_type='reserve'`;
    console.log("[DEBUG] generateReserveCode query:", query);
    const [rows] = await connection.execute(query, [`${prefix}%`]);
    const newNumber = rows[0].count + 1;
    const code = prefix + newNumber.toString().padStart(5, '0'); // 총 6자리
    console.log("[INFO] Generated code:", code);
    return code;
  } catch (err) {
    console.error("[ERROR] generateReserveCode:", err);
    return prefix + '99999'; // 오류 시 임시 코드
  } finally {
    connection.release();
  }
}

// ------------------------------------------------------
// Server Initialization
// ------------------------------------------------------
const port = process.env.PORT || 8000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
