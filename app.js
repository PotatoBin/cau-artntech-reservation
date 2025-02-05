/*********************************************
 * app.js
 *********************************************/
require("dotenv").config();
const express = require('express');
const app = express();
const router = express.Router();
const mysql = require('mysql2/promise');
const morgan = require('morgan');

// morgan 로그 (서버가 KST라면 new Date() 그대로)
morgan.token('date-kst', () => {
  const now = new Date();
  const yyyy = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}`;
});
morgan.format('combined-kst',
  ':remote-addr - :remote-user [:date-kst] ":method :url HTTP/:http-version" :status :res[content-length] :response-time ms ":referrer" ":user-agent"'
);

// DB pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(morgan('combined-kst'));
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
router.post('/check/reserve_code', async (req, res) => await reserveCodeCheck(req.body, res));
router.post('/cancel', async (req, res) => await reserveCancel(req.body, res));
router.head('/wakeup', async (req, res) => {
  console.log("[INFO] wakeup endpoint called");
  res.status(200).send();
});

// -------------------------------
// Helper
// -------------------------------
function parseClientInfo(str) {
  const cleaned = str.replace(/[\s-]/g, '');
  const parts = cleaned.split(',');
  return { name: parts[0], id: parts[1], phone: parts[2] };
}
function hideMiddleChar(str) {
  if (str.length < 3) return str[0] + '*';
  return str[0] + '*'.repeat(str.length - 2) + str[str.length - 1];
}
function isWrongHours(startStr, endStr) {
  const [sh, sm] = startStr.split(':').map(Number);
  const [eh, em] = endStr.split(':').map(Number);
  const diff = (eh*60 + em) - (sh*60 + sm);
  return diff < 30 || diff > 240;
}
function isAvailableTime() {
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours();
  if (day===0 || day===6) {
    console.log("[WARN] Weekend");
    return false;
  }
  if (hour<9 || hour>=22) {
    console.log("[WARN] Out of hours");
    return false;
  }
  console.log("[INFO] isAvailableTime -> OK");
  return true;
}

// -------------------------------
// (A) 방/GLAB 예약
// -------------------------------
async function reserve(reqBody, res, room_type) {
  console.log("[INFO] reserve() called ->", room_type);
  try {
    const start_time_str = JSON.parse(reqBody.action.params.start_time).value; // "15:00"
    const end_time_str = JSON.parse(reqBody.action.params.end_time).value;     // "17:00"
    const client_info = parseClientInfo(reqBody.action.params.client_info);
    const kakao_id = reqBody.userRequest.user.id;
    
    const now = new Date();
    const todayDate = now.toISOString().split('T')[0];
    const start_db = `${todayDate} ${start_time_str}:00`;
    const end_db   = `${todayDate} ${end_time_str}:00`;
    const displayTime = `${start_time_str} - ${end_time_str}`;

    let table;
    if (['01BLUE','02GRAY','03SILVER','04GOLD'].includes(room_type)) table='new_media_library';
    else if (['GLAB1','GLAB2'].includes(room_type)) table='glab';
    else {
      console.log("[FAIL] Invalid room_type:", room_type);
      return res.send({ status:"FAIL", message:"잘못된 방 유형" });
    }

    if (!isAvailableTime()) {
      console.log("[WARN] Not available time");
      return res.send({
        "version": "2.0",
        "template": {
          "outputs": [{
            "textCard": {
              "title": "현재 예약할 수 없는 시간입니다.",
              "description": "평일 9시부터 22시까지 당일 예약만 가능합니다.",
              "buttons": [{ "label": "처음으로", "action": "block", "messageText": "처음으로" }]
            }
          }]
        }
      });
    }

    if (isWrongHours(start_time_str, end_time_str)) {
      console.log("[WARN] Wrong hours");
      return res.send({
        "version": "2.0",
        "template": {
          "outputs": [{
            "textCard": {
              "title": "30분부터 최대 4시간까지 신청 가능합니다.",
              "description": `- 방 종류: ${room_type}\n- 신청한 시간: ${displayTime}\n\n다시 시도해주세요.`,
              "buttons": [{ "label": "처음으로", "action": "block", "messageText": "처음으로" }]
            }
          }]
        }
      });
    }

    if (await checkOverlap(table, start_db, end_db, room_type)) {
      console.log("[WARN] Overlap found ->", room_type);
      return res.send({
        "version": "2.0",
        "template": {
          "outputs": [{
            "textCard": {
              "title": "해당 일시에 겹치는 예약이 있습니다.",
              "description": `- 방 종류: ${room_type}\n- 신청한 시간: ${displayTime}\n\n예약 현황을 조회하시고 비어있는 시간에 다시 신청해주세요.`,
              "buttons": [{ "label": "처음으로", "action": "block", "messageText": "처음으로" }]
            }
          }]
        }
      });
    }

    const reserve_code = await generateReserveCode(room_type);
    const hiddenName = hideMiddleChar(client_info.name);
    await addToDatabase(table, reserve_code, room_type, start_db, end_db, hiddenName, client_info, kakao_id);

    console.log("[SUCCESS] Reserved ->", reserve_code);
    return res.send({
      "version": "2.0",
      "template": {
        "outputs": [{
          "textCard": {
            "title": "성공적으로 예약되었습니다.",
            "description": `- 방 종류: ${room_type}\n- 예약 번호: ${reserve_code}\n- 대여 시간: ${displayTime}\n- 신청자: ${hiddenName}`,
            "buttons": [{ "label": "처음으로", "action": "block", "messageText": "처음으로" }]
          }
        }]
      }
    });
  } catch (err) {
    console.error("[ERROR] reserve:", err);
    return res.send({ "status": "FAIL", "message": "예약 처리 중 오류가 발생했습니다." });
  }
}

// -------------------------------
// (B) 충전기 예약
// -------------------------------
async function reserveCharger(reqBody, res, type) {
  console.log("[INFO] reserveCharger() ->", type);
  try {
    const start_time_str = JSON.parse(reqBody.action.params.start_time).value;
    const end_time_str   = JSON.parse(reqBody.action.params.end_time).value;
    const client_info    = parseClientInfo(reqBody.action.params.client_info);
    const kakao_id       = reqBody.userRequest.user.id;
    const displayTime    = `${start_time_str} - ${end_time_str}`;

    const now = new Date();
    const todayDate = now.toISOString().split('T')[0];
    const start_db = `${todayDate} ${start_time_str}:00`;
    const end_db   = `${todayDate} ${end_time_str}:00`;
    const table = 'charger';

    if (await isNotPayer(client_info.name, client_info.id)) {
      console.log("[WARN] Not a payer");
      const desc = `- 이름: ${client_info.name}\n- 학번: ${client_info.id}\n2024학년도 1학기 예술공학대학 학생회비 납부자가 아닙니다.`;
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{"textCard":{
            "title":"학생회비 납부자가 아닙니다.",
            "description":desc,
            "buttons":[{ "label":"처음으로","action":"block","messageText":"처음으로"}]
          }}]
        }
      });
    }
    if (!isAvailableTime()) {
      console.log("[WARN] Not available time");
      const desc = `평일 9시부터 22시까지 당일 예약만 가능합니다.`;
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{"textCard":{
            "title":"현재 예약할 수 없는 시간입니다.",
            "description":desc,
            "buttons":[{ "label":"처음으로","action":"block","messageText":"처럼으로"}]
          }}]
        }
      });
    }
    if (isWrongHours(start_time_str, end_time_str)) {
      console.log("[WARN] Wrong hours-charger");
      const desc = `- 충전기 종류: ${type}\n- 신청한 시간: ${displayTime}\n\n다시 시도해주세요.`;
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{"textCard":{
            "title":"30분부터 최대 4시간까지 신청 가능합니다.",
            "description":desc,
            "buttons":[{ "label":"처음으로","action":"block","messageText":"처음으로"}]
          }}]
        }
      });
    }

    if (await checkOverlap(table, start_db, end_db, `${type} 1`)) {
      console.log("[DEBUG] Overlap with type1");
      if (await checkOverlap(table, start_db, end_db, `${type} 2`)) {
        console.log("[WARN] All overlapped");
        const desc = `- 충전기 종류: ${type}\n- 신청한 시간: ${displayTime}\n\n예약 현황을 조회하시고 다시 시도해주세요.`;
        return res.send({
          "version":"2.0",
          "template":{
            "outputs":[{"textCard":{
              "title":"모든 충전기가 사용중입니다.",
              "description":desc,
              "buttons":[{ "label":"처음으로","action":"block","messageText":"처음으로"}]
            }}]
          }
        });
      } else {
        console.log("[INFO] Using type2");
        const reserve_code = await generateReserveCode('CHARGER');
        const hiddenName = hideMiddleChar(client_info.name);
        const locker_pwd = await getLockertPassword(`${type} 2`);
        const desc = `- 충전기 종류: ${type} 2\n- 사물함 비밀번호: ${locker_pwd}\n- 예약 번호: ${reserve_code}\n- 대여 시간: ${displayTime}\n- 신청자: ${hiddenName}`;
        res.send({
          "version":"2.0",
          "template":{
            "outputs":[{"textCard":{
              "title":"성공적으로 대여하였습니다.",
              "description":desc,
              "buttons":[{ "label":"처음으로","action":"block","messageText":"처음으로"}]
            }}]
          }
        });
        await addToDatabaseCharger(table, reserve_code, `${type} 2`, start_db, end_db, hiddenName, client_info, kakao_id);
        console.log("[SUCCESS] Charger type2 ->", reserve_code);
        return;
      }
    }
    console.log("[INFO] Using type1");
    const reserve_code = await generateReserveCode('CHARGER');
    const hiddenName = hideMiddleChar(client_info.name);
    const locker_pwd = await getLockertPassword(`${type} 1`);
    const desc = `- 충전기 종류: ${type} 1\n- 사물함 비밀번호: ${locker_pwd}\n- 예약 번호: ${reserve_code}\n- 대여 시간: ${displayTime}\n- 신청자: ${hiddenName}`;
    res.send({
      "version":"2.0",
      "template":{
        "outputs":[{"textCard":{
          "title":"성공적으로 대여하였습니다.",
          "description":desc,
          "buttons":[{ "label":"처음으로","action":"block","messageText":"처음으로"}]
        }}]
      }
    });
    await addToDatabaseCharger(table, reserve_code, `${type} 1`, start_db, end_db, hiddenName, client_info, kakao_id);
    console.log("[SUCCESS] Charger type1 ->", reserve_code);

  } catch (err) {
    console.error("[ERROR] reserveCharger:", err);
    return res.send({"status":"FAIL","message":"충전기 예약 중 오류발생"});
  }
}
async function addToDatabaseCharger(table, code, ctype, startdb, enddb, masked, info, kid) {
  console.log("[INFO] addToDatabaseCharger->", ctype, code);
  const conn = await pool.getConnection();
  try {
    const q=`INSERT INTO ${table} (reserve_code, charger_type, start_time, end_time, masked_name) VALUES (?,?,?,?,?)`;
    console.log("[DEBUG] charger insert:", q);
    await conn.execute(q,[code,ctype,startdb,enddb,masked]);
    const logQ=`
      INSERT INTO logs (reserve_code, room_type, request_type, name, student_id, phone, kakao_id)
      VALUES (?,?,?,?,?,?,?)
    `;
    console.log("[DEBUG] logs insert:", logQ);
    await conn.execute(logQ,[code,ctype,'reserve',info.name,info.id,info.phone,kid]);
  } finally { conn.release(); }
}

// -------------------------------
// (C) 예약 취소
// -------------------------------
async function reserveCancel(reqBody, res) {
  console.log("[INFO] reserveCancel() called");
  try {
    const reserve_code = reqBody.action.params.reserve_code;
    const kakao_id = reqBody.userRequest.user.id;
    console.log("[DEBUG] code=", reserve_code, "kakao_id=", kakao_id);

    const conn = await pool.getConnection();
    let logRow;
    try {
      const query=`
        SELECT * FROM logs WHERE reserve_code=? AND request_type='reserve'
      `;
      console.log("[DEBUG] cancel-check logs:", query);
      const [rows]=await conn.execute(query,[reserve_code]);
      if (!rows.length) {
        console.log("[FAILED] No matching reserve code:", reserve_code);
        const d=`다시 시도해주세요.`;
        res.send({
          "version":"2.0",
          "template":{
            "outputs":[{"textCard":{
              "title":"예약번호와 일치하는 예약이 없습니다",
              "description":d,
              "buttons":[{ "label":"처음으로","action":"block","messageText":"처음으로"}]
            }}]
          }
        });
        return;
      }
      logRow=rows[0];
      if (logRow.kakao_id!==kakao_id) {
        console.log("[FAILED] Another person's code:", reserve_code);
        const d=`신청자의 카카오톡 계정으로 취소해주세요.`;
        res.send({
          "version":"2.0",
          "template":{
            "outputs":[{"textCard":{
              "title":"신청자 본인이 아닙니다",
              "description":d,
              "buttons":[{ "label":"처음으로","action":"block","messageText":"처음으로"}]
            }}]
          }
        });
        return;
      }
    } finally { conn.release(); }

    let table;
    const c=reserve_code[0];
    if (['1','2','3','4'].includes(c)) table='new_media_library';
    else if(['5','6'].includes(c)) table='glab';
    else if(['7'].includes(c)) table='charger';
    else {
      console.log("[FAILED] Unknown code prefix:", c);
      const d=`다시 시도해주세요.`;
      return res.send({
        "version":"2.0",
        "template":{
          "outputs":[{"textCard":{
            "title":"잘못된 예약코드입니다",
            "description":d,
            "buttons":[{ "label":"처음으로","action":"block","messageText":"처음으로"}]
          }}]
        }
      });
    }

    const conn2=await pool.getConnection();
    try {
      const checkQ=`SELECT * FROM ${table} WHERE reserve_code=?`;
      console.log("[DEBUG] check table row:", checkQ);
      const [checkRows]=await conn2.execute(checkQ,[reserve_code]);
      if(!checkRows.length) {
        console.log("[FAILED] Already canceled:", reserve_code);
        const d=`다시 시도해주세요.`;
        res.send({
          "version":"2.0",
          "template":{
            "outputs":[{"textCard":{
              "title":"이미 취소된 예약입니다",
              "description":d,
              "buttons":[{ "label":"처음으로","action":"block","messageText":"처음으로"}]
            }}]
          }
        });
        return;
      }

      const delQ=`DELETE FROM ${table} WHERE reserve_code=?`;
      console.log("[DEBUG] delete row:", delQ);
      await conn2.execute(delQ,[reserve_code]);

      const logQ=`
        INSERT INTO logs (reserve_code, room_type, request_type, name, student_id, phone, kakao_id)
        VALUES (?,?,?,?,?,?,?)
      `;
      console.log("[DEBUG] insert cancel log:", logQ);
      await conn2.execute(logQ,[
        logRow.reserve_code,
        logRow.room_type,
        'cancel',
        logRow.name,
        logRow.student_id,
        logRow.phone,
        logRow.kakao_id
      ]);

      const origin=checkRows[0];
      const st=origin.start_time.substring(11,16);
      const et=origin.end_time.substring(11,16);
      const time_string=`${st} - ${et}`;
      const hiddenName=origin.masked_name;
      const d=`- ${logRow.room_type}\n- 예약 번호: ${reserve_code}\n- 대여 시간: ${time_string}\n- 신청자: ${hiddenName}`;

      res.send({
        "version":"2.0",
        "template":{
          "outputs":[{"textCard":{
            "title":"대여를 취소했습니다",
            "description":d,
            "buttons":[{ "label":"처음으로","action":"block","messageText":"처음으로"}]
          }}]
        }
      });
      console.log("[SUCCESS] reserveCancel ->", reserve_code);
    } finally { conn2.release(); }
  } catch (err) {
    console.error("[ERROR] reserveCancel:", err);
    return res.send({"status":"FAIL","message":"예약 취소 중 오류발생"});
  }
}

// -------------------------------
// (D) 유효성 검증
// -------------------------------
async function reserveStartTimeCheck(reqBody, res) {
  console.log("[INFO] reserveStartTimeCheck");
  try {
    const st=reqBody.value.origin.slice(0,5);
    const now=new Date();
    const curMin = now.getHours()*60 + now.getMinutes();
    const [sh,sm] = st.split(':').map(Number);
    const startMin = sh*60+sm;
    const diff = startMin - curMin;
    if (diff < 30 && diff < 0) {
      console.log("[FAILED] Not available for 30 min ago ->", st);
      return res.send({ "status":"FAIL","message":"30분 전 시간은 예약할 수 없습니다." });
    }
    console.log("[SUCCESS] startTime->", st);
    res.send({ "status":"SUCCESS" });
  } catch(e) {
    console.error("[ERROR] reserveStartTimeCheck:", e);
    res.send({ "status":"FAIL","message":"잘못된 요청" });
  }
}
async function reserveClientInfoCheck(reqBody, res) {
  console.log("[INFO] reserveClientInfoCheck");
  try {
    const str=reqBody.value.origin;
    const cleaned=str.replace(/[\s-]/g,'');
    const parts=cleaned.split(',');
    if(parts.length!==3) {
      console.log("[FAILED] Invalid client info->", str);
      return res.send({"status":"FAIL","message":"이름,학번,전화번호"});
    }
    const name=parts[0],sid=parts[1],pho=parts[2];
    if(!/^\d{8}$/.test(sid)) {
      console.log("[FAILED] Invalid studentID->", sid);
      return res.send({"status":"FAIL","message":"학번은 8자리"});
    }
    if(!/^\d{11}$/.test(pho)) {
      console.log("[FAILED] Invalid phone->", pho);
      return res.send({"status":"FAIL","message":"전화번호는 11자리"});
    }
    if(!name||name.length<1) {
      console.log("[FAILED] Invalid name->", name);
      return res.send({"status":"FAIL","message":"이름을 입력해주세요."});
    }
    console.log("[SUCCESS] clientInfo->", name,sid,pho);
    res.send({"status":"SUCCESS"});
  } catch(e) {
    console.error("[ERROR] reserveClientInfoCheck:", e);
    res.send({"status":"FAIL","message":"잘못된 요청"});
  }
}
async function reserveCodeCheck(reqBody, res) {
  console.log("[INFO] reserveCodeCheck");
  try {
    const code=reqBody.value.origin;
    if(!/^\d{6}$/.test(code)) {
      console.log("[FAILED] Invalid code->", code);
      return res.send({"status":"FAIL","message":"올바른 형식의 예약코드가 아님"});
    }
    const conn=await pool.getConnection();
    try {
      const q=`SELECT * FROM logs WHERE reserve_code=?`;
      console.log("[DEBUG] logs code->", q);
      const [rows]=await conn.execute(q,[code]);
      if(!rows.length) {
        console.log("[FAILED] code not found->", code);
        return res.send({"status":"FAIL","message":"존재하지 않는 예약코드"});
      }
      console.log("[SUCCESS] code->", code);
      res.send({"status":"SUCCESS"});
    } finally { conn.release(); }
  } catch(e) {
    console.error("[ERROR] reserveCodeCheck:", e);
    res.send({"status":"FAIL","message":"잘못된 요청"});
  }
}

// -------------------------------
// (E) 중복 예약 -> 당일만
// -------------------------------
async function checkOverlap(table, startdb, enddb, rtype) {
  console.log("[INFO] checkOverlap-> table:", table,"type:", rtype);
  const conn=await pool.getConnection();
  try {
    // created_at이 오늘인 데이터만 검사
    // AND (room_type=? OR charger_type=?) AND 시간 겹침
    const q=`
      SELECT * FROM ${table}
      WHERE 
        DATE(created_at)=CURDATE()
        AND (room_type=? OR charger_type=?)
        AND (
          (start_time<=? AND end_time>?)
          OR (start_time<? AND end_time>=?)
          OR (start_time>=? AND end_time<=?)
        )
    `;
    console.log("[DEBUG] overlap query->", q);
    const [rows]=await conn.execute(q,[rtype,rtype,startdb,startdb,enddb,enddb,startdb,enddb]);
    console.log("[DEBUG] overlap count->", rows.length);
    return rows.length>0;
  } catch(e) {
    console.error("[ERROR] checkOverlap:", e);
    return false;
  } finally { conn.release(); }
}

// -------------------------------
// (F) DB 삽입
// -------------------------------
async function addToDatabase(table, code, rtype, startdb, enddb, masked, info, kid) {
  console.log("[INFO] addToDatabase->", table, code);
  const conn=await pool.getConnection();
  try {
    const q=`INSERT INTO ${table} (reserve_code, room_type, start_time, end_time, masked_name) VALUES (?,?,?,?,?)`;
    console.log("[DEBUG] space insert:", q);
    await conn.execute(q,[code,rtype,startdb,enddb,masked]);
    const logQ=`
      INSERT INTO logs (reserve_code, room_type, request_type, name, student_id, phone, kakao_id)
      VALUES (?,?,?,?,?,?,?)
    `;
    console.log("[DEBUG] logs insert:", logQ);
    await conn.execute(logQ,[code,rtype,'reserve',info.name,info.id,info.phone,kid]);
  } finally { conn.release(); }
}
async function isNotPayer(name, id) {
  console.log("[INFO] isNotPayer->", name,id);
  const conn=await pool.getConnection();
  try {
    const q=`SELECT * FROM payers WHERE student_id=? AND name=?`;
    console.log("[DEBUG] payer query->",q);
    const [rows]=await conn.execute(q,[id,name]);
    console.log("[DEBUG] payers found->", rows.length);
    return rows.length===0;
  } catch(e) {
    console.error("[ERROR] isNotPayer:", e);
    return true;
  } finally { conn.release(); }
}
async function getLockertPassword(type) {
  console.log("[INFO] getLockertPassword->", type);
  const conn=await pool.getConnection();
  try {
    const q=`SELECT password FROM charger_lockers WHERE charger_type=?`;
    console.log("[DEBUG] locker query->",q);
    const [rows]=await conn.execute(q,[type]);
    if(!rows.length) {
      console.log("[WARN] No locker found->", type);
      return '0000';
    }
    return rows[0].password;
  } catch(e) {
    console.error("[ERROR] getLockertPassword:", e);
    return '0000';
  } finally { conn.release(); }
}
async function generateReserveCode(rtype) {
  console.log("[INFO] generateReserveCode->", rtype);
  const room_codes={
    '01BLUE':'1','02GRAY':'2','03SILVER':'3','04GOLD':'4','GLAB1':'5','GLAB2':'6'
  };
  const prefix=(rtype==='CHARGER')?'7':(room_codes[rtype]||'9');
  const conn=await pool.getConnection();
  try {
    const q=`SELECT COUNT(*) AS cnt FROM logs WHERE room_type LIKE ? AND request_type='reserve'`;
    console.log("[DEBUG] code gen->", q);
    const [rows]=await conn.execute(q,[`${prefix}%`]);
    const newN=rows[0].cnt+1;
    const code=prefix+String(newN).padStart(5,'0');
    console.log("[INFO] new code->", code);
    return code;
  } catch(e) {
    console.error("[ERROR] generateReserveCode:", e);
    return prefix+'99999';
  } finally { conn.release(); }
}

// -------------------------------
// Server init
// -------------------------------
const port=process.env.PORT||8000;
app.listen(port,()=>{
  console.log(`Server running on port ${port}`);
});
