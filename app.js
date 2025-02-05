/*********************************************
 * app.js  (서버 전체 코드 예시)
 *********************************************/

require("dotenv").config();
const express = require('express');
const app = express();
const router = express.Router();

const mysql = require('mysql2/promise');

// 1) morgan + KST 로그 설정
const morgan = require('morgan');

/**
 * morgan 토큰(date-kst)에서 서버 로컬 시간을 그대로 사용
 * (서버가 이미 KST라면 new Date()가 KST 시각을 반환)
 */
morgan.token('date-kst', () => {
  const now = new Date(); // 추가 +9시간 하지 않음
  const yyyy = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}`;
});

// 커스텀 포맷('combined-kst') 정의
morgan.format('combined-kst',
  ':remote-addr - :remote-user [:date-kst] ":method :url HTTP/:http-version" :status :res[content-length] :response-time ms ":referrer" ":user-agent"'
);

// 2) DB 풀 연결 설정
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// 3) Express 미들웨어
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// 4) morgan(한국 시각 로그) 사용
app.use(morgan('combined-kst'));

// 5) 라우팅 설정
app.use('/reserve', router);

/***********************************************
 * Routes
 ***********************************************/

// 방(공간) 예약
router.post('/01BLUE', async (req, res) => await reserve(req.body, res, '01BLUE'));
router.post('/02GRAY', async (req, res) => await reserve(req.body, res, '02GRAY'));
router.post('/03SILVER', async (req, res) => await reserve(req.body, res, '03SILVER'));
router.post('/04GOLD', async (req, res) => await reserve(req.body, res, '04GOLD'));
router.post('/GLAB1', async (req, res) => await reserve(req.body, res, 'GLAB1'));
router.post('/GLAB2', async (req, res) => await reserve(req.body, res, 'GLAB2'));

// 충전기 예약
router.post('/CHARGER01', async (req, res) => await reserveCharger(req.body, res, '노트북 충전기 (C-Type 65W)'));
router.post('/CHARGER02', async (req, res) => await reserveCharger(req.body, res, '스마트폰 충전기 (C-Type)'));
router.post('/CHARGER03', async (req, res) => await reserveCharger(req.body, res, '아이폰 충전기 (8pin)'));

// 유효성 검사
router.post('/check/start_time', async (req, res) => await reserveStartTimeCheck(req.body, res));
router.post('/check/client_info', async (req, res) => await reserveClientInfoCheck(req.body, res));
router.post('/check/reserve_code', async (req, res) => await reserveCodeCheck(req.body, res));

// 예약 취소
router.post('/cancel', async (req, res) => await reserveCancel(req.body, res));

// 깨어나기(Health Check)
router.head('/wakeup', async (req, res) => {
  console.log("[INFO] wakeup endpoint called");
  res.status(200).send();
});

/***********************************************
 * 1) getKSTDate -> 실제론 단순 new Date() (서버 KST)
 ***********************************************/
function getKSTDate() {
  // 서버가 이미 KST라면 new Date()만으로 KST 시각
  return new Date();
}

/***********************************************
 * 2) 시간대 관련: 평일(월~금) 09:00~22:00 체크
 ***********************************************/
function isAvailableTime() {
  // "예약 불가능"이면 true, 가능이면 false
  const now = getKSTDate();
  const hour = now.getHours();
  const day = now.getDay(); // 0: 일, 1: 월, ..., 6: 토

  // 토(6), 일(0)이면 불가
  if (day === 0 || day === 6) {
    console.log(`[WARN] Today is weekend(day=${day}), reservation not available`);
    return true;
  }
  // 9시 이하 or 22시 이상이면 불가
  if (hour < 9 || hour >= 22) {
    console.log(`[WARN] Current hour=${hour}, not in [9,22)`);
    return true;
  }
  console.log(`[INFO] isAvailableTime -> available (day=${day}, hour=${hour})`);
  return false;
}

/***********************************************
 * 3) 방/공간 예약 함수 (reserve)
 ***********************************************/
async function reserve(reqBody, res, room_type) {
  console.log("[INFO] reserve() called -> room_type:", room_type);
  try {
    const start_time_str = JSON.parse(reqBody.action.params.start_time).value;
    const end_time_str = JSON.parse(reqBody.action.params.end_time).value;
    const client_info = parseClientInfo(reqBody.action.params.client_info);
    const kakao_id = reqBody.userRequest.user.id;
    
    // 오늘 날짜(서버 KST)
    const now = getKSTDate();
    const todayDate = now.toISOString().split('T')[0];
    const start_time = `${todayDate} ${start_time_str}:00`;
    const end_time = `${todayDate} ${end_time_str}:00`;
    const time_string = `${start_time_str} - ${end_time_str}`;

    let table;
    if (['01BLUE','02GRAY','03SILVER','04GOLD'].includes(room_type)) {
      table = 'new_media_library';
    } else if (['GLAB1','GLAB2'].includes(room_type)) {
      table = 'glab';
    } else {
      console.log(`[FAIL] Invalid room_type: ${room_type}`);
      return res.send({ status: "FAIL", message: "잘못된 방 유형입니다." });
    }

    // 1) 시간 가능 여부
    if (isAvailableTime()) {
      console.log("[WARN] Not available time -> returning error message");
      return res.send({
        "version": "2.0",
        "template": {
          "outputs": [{
            "textCard": {
              "title": "현재 예약할 수 없는 시간입니다.",
              "description": "평일 9시부터 22시까지 당일 예약만 가능합니다.",
              "buttons": [
                { "label": "처음으로", "action": "block", "messageText": "처음으로" }
              ]
            }
          }]
        }
      });
    }

    // 2) 30분 ~ 최대 4시간
    if (isWrongHours(start_time_str, end_time_str)) {
      console.log("[WARN] Wrong hours -> start_time >= end_time or over 4hr");
      return res.send({
        "version": "2.0",
        "template": {
          "outputs": [{
            "textCard": {
              "title": "30분부터 최대 4시간까지 신청 가능합니다.",
              "description": `- 방 종류: ${room_type}\n- 신청한 시간: ${time_string}\n\n처음부터 다시 시도해주세요. 종료 시각이 시작 시각 이전으로 작성되었는지 확인해주세요.`,
              "buttons": [
                { "label": "처음으로", "action": "block", "messageText": "처음으로" }
              ]
            }
          }]
        }
      });
    }

    // 3) 중복 체크
    if (await checkOverlap(table, start_time, end_time, room_type)) {
      console.log("[WARN] Overlap found -> returning");
      return res.send({
        "version": "2.0",
        "template": {
          "outputs": [{
            "textCard": {
              "title": "해당 일시에 겹치는 예약이 있습니다.",
              "description": `- 방 종류: ${room_type}\n- 신청한 시간: ${time_string}\n\n예약 현황을 조회하시고, 비어있는 시간에 다시 신청해주세요.`,
              "buttons": [
                { "label": "처음으로", "action": "block", "messageText": "처음으로" }
              ]
            }
          }]
        }
      });
    }

    // 4) 예약 코드 생성 & DB 기록
    const reserve_code = await generateReserveCode(room_type);
    const hiddenName = hideMiddleChar(client_info.name);
    await addToDatabase(table, reserve_code, room_type, start_time, end_time, hiddenName, client_info, kakao_id);
    console.log(`[SUCCESS] Reserved room -> code=${reserve_code}`);

    // 5) 성공 응답
    return res.send({
      "version": "2.0",
      "template": {
        "outputs": [{
          "textCard": {
            "title": "성공적으로 예약되었습니다.",
            "description": `- 방 종류: ${room_type}\n- 예약 번호: ${reserve_code}\n- 대여 시간: ${time_string}\n- 신청자: ${hiddenName}`,
            "buttons": [
              { "label": "처음으로", "action": "block", "messageText": "처음으로" }
            ]
          }
        }]
      }
    });
  } catch (err) {
    console.error("[ERROR] reserve():", err);
    return res.send({ "status": "FAIL", "message": "예약 처리 중 오류가 발생했습니다." });
  }
}

/***********************************************
 * 4) 충전기 예약 함수 (reserveCharger)
 ***********************************************/
async function reserveCharger(reqBody, res, type) {
  console.log("[INFO] reserveCharger() called -> type:", type);
  try {
    const start_time_str = JSON.parse(reqBody.action.params.start_time).value;
    const end_time_str = JSON.parse(reqBody.action.params.end_time).value;
    const client_info = parseClientInfo(reqBody.action.params.client_info);
    const kakao_id = reqBody.userRequest.user.id;
    const time_string = `${start_time_str.slice(0, 5)} - ${end_time_str.slice(0, 5)}`;

    // KST
    const now = getKSTDate();
    const todayDate = now.toISOString().split('T')[0];
    const start_time = `${todayDate} ${start_time_str}:00`;
    const end_time = `${todayDate} ${end_time_str}:00`;

    const table = 'charger';

    // 1) 학생회비 납부자 여부
    if (await isNotPayer(client_info.name, client_info.id)) {
      console.log("[WARN] Not a payer ->", client_info.name, client_info.id);
      const description = `- 이름: ${client_info.name}\n- 학번: ${client_info.id}\n2024학년도 1학기 예술공학대학 학생회비 납부자가 아닙니다. 정보를 제대로 입력하였는지 확인해주시고, 학생회 채널로 문의 바랍니다.`;
      res.send({
        "version": "2.0",
        "template": {
          "outputs": [
            {
              "textCard": {
                "title": "학생회비 납부자가 아닙니다.",
                "description": description,
                "buttons": [
                  { "label": "처음으로", "action": "block", "messageText": "처음으로" }
                ]
              }
            }
          ]
        }
      });
      return;
    }

    // 2) 시간 가능 여부
    if (isAvailableTime()) {
      console.log("[WARN] Not available time for charger");
      const description = `평일 9시부터 22시까지 당일 예약만 가능합니다.`;
      res.send({
        "version": "2.0",
        "template": {
          "outputs": [
            {
              "textCard": {
                "title": "현재 예약할 수 없는 시간입니다.",
                "description": description,
                "buttons": [
                  { "label": "처음으로", "action": "block", "messageText": "처음으로" }
                ]
              }
            }
          ]
        }
      });
      return;
    }

    // 3) 30분 ~ 최대 4시간
    if (isWrongHours(start_time_str, end_time_str)) {
      console.log("[WARN] Wrong hours for charger");
      const description = `- 충전기 종류: ${type}\n- 신청한 시간: ${time_string}\n\n처음부터 다시 시도해주세요. 종료 시각이 시작 시각 이전으로 작성되었는지 확인해주세요.`;
      res.send({
        "version": "2.0",
        "template": {
          "outputs": [
            {
              "textCard": {
                "title": "30분부터 최대 4시간까지 신청 가능합니다.",
                "description": description,
                "buttons": [
                  { "label": "처음으로", "action": "block", "messageText": "처음으로" }
                ]
              }
            }
          ]
        }
      });
      return;
    }

    // 4) 중복 체크 -> type1 먼저
    if (await checkOverlap(table, start_time, end_time, `${type} 1`)) {
      console.log(`[DEBUG] Overlap with ${type} 1 -> checking ${type} 2`);
      if (await checkOverlap(table, start_time, end_time, `${type} 2`)) {
        // 둘 다 겹침
        console.log("[WARN] Both chargers overlapped");
        const description = `- 충전기 종류: ${type}\n- 신청한 시간: ${time_string}\n\n예약 현황을 조회하시고, 비어있는 시간에 다시 신청해주세요.`;
        res.send({
          "version": "2.0",
          "template": {
            "outputs": [
              {
                "textCard": {
                  "title": "모든 충전기가 사용중입니다.",
                  "description": description,
                  "buttons": [
                    { "label": "처음으로", "action": "block", "messageText": "처음으로" }
                  ]
                }
              }
            ]
          }
        });
        return;
      } else {
        // type1 겹침, type2 가능
        console.log("[INFO] Using type2 charger");
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
                  "buttons": [
                    { "label": "처음으로", "action": "block", "messageText": "처음으로" }
                  ]
                }
              }
            ]
          }
        });
        await addToDatabaseCharger(table, reserve_code, `${type} 2`, start_time, end_time, hiddenName, client_info, kakao_id);
        console.log("[SUCCESS] Reserved charger -> type2, code=", reserve_code);
        return;
      }
    }

    // type1 가능
    console.log("[INFO] Using type1 charger");
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
              "buttons": [
                { "label": "처음으로", "action": "block", "messageText": "처음으로" }
              ]
            }
          }
        ]
      }
    });
    await addToDatabaseCharger(table, reserve_code, `${type} 1`, start_time, end_time, hiddenName, client_info, kakao_id);
    console.log("[SUCCESS] Reserved charger -> type1, code=", reserve_code);

  } catch (err) {
    console.error("[ERROR] reserveCharger:", err);
    return res.send({ "status": "FAIL", "message": "충전기 예약 중 오류가 발생했습니다." });
  }
}

// charger DB 삽입
async function addToDatabaseCharger(table, reserve_code, charger_type, start_time, end_time, masked_name, client_info, kakao_id) {
  console.log("[INFO] addToDatabaseCharger ->", charger_type, reserve_code);
  const connection = await pool.getConnection();
  try {
    const query = `INSERT INTO ${table} (reserve_code, charger_type, start_time, end_time, masked_name) VALUES (?, ?, ?, ?, ?)`;
    console.log("[DEBUG] charger insert:", query);
    await connection.execute(query, [reserve_code, charger_type, start_time, end_time, masked_name]);

    const logQuery = `
      INSERT INTO logs (reserve_code, room_type, request_type, name, student_id, phone, kakao_id)
      VALUES (?, ?, 'reserve', ?, ?, ?, ?)
    `;
    console.log("[DEBUG] logs insert:", logQuery);
    await connection.execute(logQuery, [reserve_code, charger_type, client_info.name, client_info.id, client_info.phone, kakao_id]);

  } finally {
    connection.release();
  }
}

/***********************************************
 * 5) 예약 취소 (reserveCancel)
 ***********************************************/
async function reserveCancel(reqBody, res) {
  console.log("[INFO] reserveCancel() called");
  try {
    const reserve_code = reqBody.action.params.reserve_code;
    const kakao_id = reqBody.userRequest.user.id;
    console.log("[DEBUG] cancel code=", reserve_code, "kakao_id=", kakao_id);

    // 1) logs 조회
    const connection = await pool.getConnection();
    let logRow;
    try {
      const query = `
        SELECT * FROM logs
        WHERE reserve_code = ? AND request_type = 'reserve'
      `;
      console.log("[DEBUG] logs-cancel query:", query);
      const [rows] = await connection.execute(query, [reserve_code]);
      if (rows.length === 0) {
        console.log("[FAILED] No matching reserve log for code:", reserve_code);
        const description = `다시 시도해주세요.`;
        res.send({
          "version": "2.0",
          "template": {
            "outputs": [
              {
                "textCard": {
                  "title": "예약번호와 일치하는 예약이 없습니다",
                  "description": description,
                  "buttons": [
                    { "label": "처음으로", "action": "block", "messageText": "처음으로" }
                  ]
                }
              }
            ]
          }
        });
        return;
      }
      logRow = rows[0];
      if (logRow.kakao_id !== kakao_id) {
        console.log("[FAILED] Another person's reservation code:", reserve_code);
        const description = `신청자의 카카오톡 계정으로 취소를 진행해주세요.`;
        res.send({
          "version": "2.0",
          "template": {
            "outputs": [
              {
                "textCard": {
                  "title": "신청자 본인이 아닙니다",
                  "description": description,
                  "buttons": [
                    { "label": "처음으로", "action": "block", "messageText": "처음으로" }
                  ]
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

    // 2) room_type prefix 확인 -> DB 테이블
    let table;
    const codeFirst = reserve_code[0];
    if (['1','2','3','4'].includes(codeFirst)) {
      table = 'new_media_library';
    } else if (['5','6'].includes(codeFirst)) {
      table = 'glab';
    } else if (['7'].includes(codeFirst)) {
      table = 'charger';
    } else {
      console.log("[FAILED] Unknown code prefix:", codeFirst);
      const description = `다시 시도해주세요.`;
      return res.send({
        "version": "2.0",
        "template": {
          "outputs": [
            {
              "textCard": {
                "title": "잘못된 예약코드입니다",
                "description": description,
                "buttons": [
                  { "label": "처음으로", "action": "block", "messageText": "처음으로" }
                ]
              }
            }
          ]
        }
      });
    }

    // 3) 실제 테이블에서 삭제
    const conn2 = await pool.getConnection();
    try {
      const checkQuery = `SELECT * FROM ${table} WHERE reserve_code = ?`;
      console.log("[DEBUG] checking table row ->", checkQuery);
      const [checkRows] = await conn2.execute(checkQuery, [reserve_code]);
      if (checkRows.length === 0) {
        console.log("[FAILED] Already canceled:", reserve_code);
        const description = `다시 시도해주세요.`;
        res.send({
          "version": "2.0",
          "template": {
            "outputs": [
              {
                "textCard": {
                  "title": "이미 취소된 예약입니다",
                  "description": description,
                  "buttons": [
                    { "label": "처음으로", "action": "block", "messageText": "처럼으로" }
                  ]
                }
              }
            ]
          }
        });
        return;
      }

      // 예약 삭제
      const delQuery = `DELETE FROM ${table} WHERE reserve_code = ?`;
      console.log("[DEBUG] delete query ->", delQuery);
      await conn2.execute(delQuery, [reserve_code]);

      // logs에 cancel 기록
      const insertLog = `
        INSERT INTO logs (reserve_code, room_type, request_type, name, student_id, phone, kakao_id)
        VALUES (?, ?, 'cancel', ?, ?, ?, ?)
      `;
      console.log("[DEBUG] insert cancel log ->", insertLog);
      await conn2.execute(insertLog, [
        logRow.reserve_code,
        logRow.room_type,
        logRow.name,
        logRow.student_id,
        logRow.phone,
        logRow.kakao_id
      ]);

      // 응답 (예약 정보)
      const originRow = checkRows[0];
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
                "buttons": [
                  { "label": "처음으로", "action": "block", "messageText": "처음으로" }
                ]
              }
            }
          ]
        }
      });
      console.log("[SUCCESS] reserveCancel done for code:", reserve_code);

    } finally {
      conn2.release();
    }

  } catch (err) {
    console.error("[ERROR] reserveCancel:", err);
    return res.send({ "status": "FAIL", "message": "예약 취소 중 오류가 발생했습니다." });
  }
}

/***********************************************
 * 6) 유효성 검사 API들
 ***********************************************/
async function reserveStartTimeCheck(reqBody, res) {
  console.log("[INFO] reserveStartTimeCheck called");
  try {
    const start_time_str = reqBody.value.origin.slice(0, 5);
    const startTime = timeStringToArray(start_time_str);
    const currentTime = getCurrentTime();
    const intervalInMinutes = getTimeInterval(currentTime, startTime);

    if (intervalInMinutes < -30) {
      console.log(`[FAILED] Not available 30 min ago -> ${start_time_str}`);
      return res.send({ "status": "FAIL", "message": "30분 전 시간은 예약할 수 없습니다." });
    }
    console.log(`[SUCCESS] Valid start_time -> ${start_time_str}`);
    return res.send({ "status": "SUCCESS" });
  } catch (error) {
    console.error("[ERROR] reserveStartTimeCheck:", error);
    return res.send({ "status": "FAIL", "message": "잘못된 요청입니다." });
  }
}

async function reserveClientInfoCheck(reqBody, res) {
  console.log("[INFO] reserveClientInfoCheck called");
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

    // 학번 8자리, 전화번호 11자리
    const studentIdPattern = /^\d{8}$/;
    const phonePattern = /^\d{11}$/;

    if (!name || name.length < 1) {
      console.log(`[FAILED] Invalid name -> ${name}`);
      return res.send({ "status": "FAIL", "message": "이름을 올바르게 입력해주세요." });
    }
    if (!studentIdPattern.test(student_id)) {
      console.log(`[FAILED] Invalid studentID -> ${student_id}`);
      return res.send({ "status": "FAIL", "message": "학번은 8자리 숫자로 입력해주세요." });
    }
    if (!phonePattern.test(phone)) {
      console.log(`[FAILED] Invalid phone -> ${phone}`);
      return res.send({ "status": "FAIL", "message": "전화번호는 11자리 숫자로 입력해주세요." });
    }

    console.log(`[SUCCESS] Valid client info -> ${name}, ${student_id}, ${phone}`);
    return res.send({ "status": "SUCCESS" });
  } catch (error) {
    console.error("[ERROR] reserveClientInfoCheck:", error);
    return res.send({ "status": "FAIL", "message": "잘못된 요청입니다." });
  }
}

async function reserveCodeCheck(reqBody, res) {
  console.log("[INFO] reserveCodeCheck called");
  try {
    const reserve_code = reqBody.value.origin;
    if (!/^\d{6}$/.test(reserve_code)) {
      console.log(`[FAILED] Invalid format code -> ${reserve_code}`);
      return res.send({ "status": "FAIL", "message": "올바른 형식의 예약 코드가 아닙니다." });
    }

    const connection = await pool.getConnection();
    try {
      const query = `SELECT * FROM logs WHERE reserve_code = ?`;
      console.log("[DEBUG] logs check code ->", query);
      const [rows] = await connection.execute(query, [reserve_code]);
      if (rows.length === 0) {
        console.log(`[FAILED] Not found code in logs -> ${reserve_code}`);
        return res.send({ "status": "FAIL", "message": "존재하지 않는 예약 코드입니다." });
      }
      console.log(`[SUCCESS] Valid code -> ${reserve_code}`);
      return res.send({ "status": "SUCCESS" });
    } finally {
      connection.release();
    }

  } catch (error) {
    console.error("[ERROR] reserveCodeCheck:", error);
    return res.send({ "status": "FAIL", "message": "잘못된 요청입니다." });
  }
}

/***********************************************
 * 7) 공통 함수들 (timeStringToArray, etc.)
 ***********************************************/
function parseClientInfo(str) {
  const cleaned = str.replace(/[\s-]/g, '');
  const parts = cleaned.split(',');
  return { name: parts[0], id: parts[1], phone: parts[2] };
}

function hideMiddleChar(str) {
  if (str.length < 3) return str[0] + '*';
  return str[0] + '*'.repeat(str.length - 2) + str[str.length - 1];
}

// "HH:MM" → [HH, MM]
function timeStringToArray(timeString) {
  const splitString = timeString.split(":");
  return splitString.map(timePart => parseInt(timePart, 10));
}

// 서버(Localtime)에서 HH, MM
function getCurrentTime() {
  const now = getKSTDate(); // 이미 KST
  return [now.getHours(), now.getMinutes()];
}

// 분 차이
function getTimeInterval(timeArray1, timeArray2) {
  const time1InMinutes = timeArray1[0] * 60 + timeArray1[1];
  const time2InMinutes = timeArray2[0] * 60 + timeArray2[1];
  return time2InMinutes - time1InMinutes;
}

// 30분 미만, 240분(4시간) 초과, start >= end 시 잘못된 시간으로 처리
function isWrongHours(start_str, end_str) {
  const [sh, sm] = start_str.split(':').map(Number);
  const [eh, em] = end_str.split(':').map(Number);
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;
  const diff = endMinutes - startMinutes;
  return diff < 30 || diff > 240;
}

// 중복 예약 체크
async function checkOverlap(table, start_time, end_time, room_type) {
  console.log("[INFO] checkOverlap -> table:", table, "type:", room_type);
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
    return false;
  } finally {
    connection.release();
  }
}

// 방/공간 예약 정보 DB 저장
async function addToDatabase(table, reserve_code, room_type, start_time, end_time, masked_name, client_info, kakao_id) {
  console.log("[INFO] addToDatabase ->", table, reserve_code);
  const connection = await pool.getConnection();
  try {
    const query = `INSERT INTO ${table} (reserve_code, room_type, start_time, end_time, masked_name) VALUES (?, ?, ?, ?, ?)`;
    console.log("[DEBUG] space insert:", query);
    await connection.execute(query, [reserve_code, room_type, start_time, end_time, masked_name]);

    const logQuery = `
      INSERT INTO logs (reserve_code, room_type, request_type, name, student_id, phone, kakao_id)
      VALUES (?, ?, 'reserve', ?, ?, ?, ?)
    `;
    console.log("[DEBUG] logs insert:", logQuery);
    await connection.execute(logQuery, [reserve_code, room_type, client_info.name, client_info.id, client_info.phone, kakao_id]);
  } finally {
    connection.release();
  }
}

// 학생회비 납부자 여부
async function isNotPayer(name, id) {
  console.log("[INFO] isNotPayer ->", name, id);
  const connection = await pool.getConnection();
  try {
    const query = `SELECT * FROM payers WHERE student_id = ? AND name = ?`;
    console.log("[DEBUG] payers query:", query);
    const [rows] = await connection.execute(query, [id, name]);
    console.log("[DEBUG] payers found:", rows.length);
    return rows.length === 0;
  } catch (err) {
    console.error("[ERROR] isNotPayer:", err);
    return true;
  } finally {
    connection.release();
  }
}

// 충전기 사물함 비밀번호 (charger_lockers 테이블)
async function getLockertPassword(type) {
  console.log("[INFO] getLockertPassword ->", type);
  const connection = await pool.getConnection();
  try {
    const query = `SELECT password FROM charger_lockers WHERE charger_type = ?`;
    console.log("[DEBUG] locker query:", query);
    const [rows] = await connection.execute(query, [type]);
    if (rows.length === 0) {
      console.log("[WARN] No locker found for type:", type);
      return '0000';
    }
    return rows[0].password;
  } catch (err) {
    console.error("[ERROR] getLockertPassword:", err);
    return '0000';
  } finally {
    connection.release();
  }
}

// 예약 코드 생성
async function generateReserveCode(room_type) {
  console.log("[INFO] generateReserveCode ->", room_type);
  const room_codes = {
    '01BLUE': '1', '02GRAY': '2', '03SILVER': '3', '04GOLD': '4',
    'GLAB1': '5', 'GLAB2': '6'
  };
  // 충전기('CHARGER')면 '7', 그 외는 '9'
  const prefix = (room_type === 'CHARGER') ? '7' : (room_codes[room_type] || '9');

  const connection = await pool.getConnection();
  try {
    const query = `SELECT COUNT(*) AS count FROM logs WHERE room_type LIKE ? AND request_type='reserve'`;
    console.log("[DEBUG] code generation query:", query);
    const [rows] = await connection.execute(query, [`${prefix}%`]);
    const newNumber = rows[0].count + 1;
    const code = prefix + newNumber.toString().padStart(5, '0');
    console.log("[INFO] New reserve code:", code);
    return code;
  } catch (err) {
    console.error("[ERROR] generateReserveCode:", err);
    return prefix + '99999'; // fallback
  } finally {
    connection.release();
  }
}

/***********************************************
 * 8) 서버 실행
 ***********************************************/
const port = process.env.PORT || 8000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
