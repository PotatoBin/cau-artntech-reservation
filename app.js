const { Client } = require("@notionhq/client");
require("dotenv").config();
const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
const morgan = require('morgan');
const express = require('express');
const app = express();
const router = express.Router();

app.use(express.json()); 
app.use(express.urlencoded( {extended : false } ));
app.use(morgan('combined'));
app.use('/reserve', router);

router.post('/01BLUE', async (req, res) => {
  await reserve(req.body, res, '01BLUE');
  });
  
router.post('/02GRAY', async (req, res) => {
  await reserve(req.body, res, '02GRAY');
  });
  
router.post('/03SILVER', async (req, res) => {
  await reserve(req.body, res, '03SILVER');
  });
  
router.post('/04GOLD', async (req, res) => {
  await reserve(req.body, res, '04GOLD');
  });
  
router.post('/GLAB1', async (req, res) => {
  await reserve(req.body, res, 'GLAB1');
  });
  
router.post('/GLAB2', async (req, res) => {
  await reserve(req.body, res, 'GLAB2');
  });

router.post('/CHARGER01', async (req, res) => {
  await reserveCharger(req.body, res, 'CHARGER01');
  });
router.post('/CHARGER02', async (req, res) => {
  await reserveCharger(req.body, res, 'CHARGER02');
  });
router.post('/CHARGER03', async (req, res) => {
  await reserveCharger(req.body, res, 'CHARGER03');
  });

router.post('/check/start_time', async (req, res) => {
  await reserveStartTimeCheck(req.body, res);
});

router.post('/check/client_info', async (req, res) => {
  await reserveClientInfoCheck(req.body, res);
});

router.post('/cancel', async (req, res) => {
  await reserveCancel(req.body, res);
});

router.post('/check/reserve_code', async (req, res) => {
  await reserveCodeCheck(req.body, res);
});

async function reserve(reqBody, res, room_type) {
  const start_time = JSON.parse(reqBody.action.params.start_time).value;
  const end_time = JSON.parse(reqBody.action.params.end_time).value;
  const client_info = parseClientInfo(reqBody.action.params.client_info);
  const total_number = reqBody.action.params.total_number;
  const kakao_id = reqBody.userRequest.user.id;
  const time_string = `${start_time.slice(0, 5)} - ${end_time.slice(0, 5)}`;

  let databaseId;
  const NewMediaLibrary = ['01BLUE','02GRAY','03SILVER','04GOLD'];
  const GLAB = ['GLAB1','GLAB2'];
  if (NewMediaLibrary.includes(room_type)) {
      databaseId = process.env.NOTION_DATABASE_NML_ID;
  } else if (GLAB.includes(room_type)) {
      databaseId = process.env.NOTION_DATABASE_GLAB_ID;
  }

  if (isAvailableTime()){
    description = `평일 9시부터 22시까지 당일 예약만 가능합니다.`;
    res.send({"version": "2.0","template": {"outputs": [{ "textCard": {"title": "현재 예약할 수 없는 시간입니다.","description": description,"buttons": [{ "label": "처음으로","action": "block","messageText": "처음으로"}]}}]}});
    return;
  }
  if (isWrongHours(start_time, end_time)){
    description = `- 방 종류 : ${room_type}\n- 신청한 시간 : ${time_string}\n\n처음부터 다시 시도해주세요. 종료 시각이 시작 시각 이전으로 작성되었는지 확인해주세요.`;
    res.send({"version": "2.0","template": {"outputs": [{ "textCard": {"title": "30분부터 최대 4시간까지 신청 가능합니다.","description": description,"buttons": [{ "label": "처음으로","action": "block","messageText": "처음으로"}]}}]}});
    return;
  }
 if (await checkOverlap(databaseId, start_time, end_time, room_type)) {
    description = `- 방 종류 : ${room_type}\n- 신청한 시간 : ${time_string}\n\n예약 현황을 조회하시고, 비어있는 시간에 다시 신청해주세요.`;
    res.send({"version": "2.0","template": {"outputs": [{ "textCard": {"title": "해당 일시에 겹치는 예약이 있습니다.","description": description,"buttons": [{ "label": "처음으로","action": "block","messageText": "처음으로"}]}}]}});
    return;
  }
  const reserve_code = await generateReserveCode(room_type);
  const hiddenName = hideMiddleChar(client_info.name);
  description = `- 방 종류 : ${room_type}\n- 예약 번호 : ${reserve_code}\n- 대여 시간 : ${time_string}\n- 신청자 : ${hiddenName}\n- 총 인원 : ${total_number} \n\n사용 후 정리 및 청소를 해주시길 바랍니다. 안내 및 준수 사항 미확인으로 생기는 문제는 책임지지 않으며, 추후 대여가 제한될 수 있습니다.`;
  res.send({"version": "2.0","template": {"outputs": [{ "textCard": {"title": "성공적으로 대여하였습니다.","description": description,"buttons": [{ "label": "처음으로","action": "block","messageText": "처음으로"}]}}]}});
  return await addToNotion(databaseId, room_type, time_string ,reserve_code, hiddenName, client_info, total_number, kakao_id);
}

async function reserveCharger(reqBody, res, type){
  const start_time = JSON.parse(reqBody.action.params.start_time).value;
  const end_time = JSON.parse(reqBody.action.params.end_time).value;
  const client_info = parseClientInfo(reqBody.action.params.client_info);
  const total_number = reqBody.action.params.total_number;
  const kakao_id = reqBody.userRequest.user.id;
  const time_string = `${start_time.slice(0, 5)} - ${end_time.slice(0, 5)}`;

  const databaseId = process.env.NOTION_DATABASE_CHARGER_ID;
  if (isNotPayer(client_info.name, client_info.id)){
    description = `2024학년도 1학기 예술공학대학 학생회비 납부자가 아닙니다. 정보를 제대로 입력하였는지 확인해주시고, 학생회 채널로 문의 바랍니다.`;
    res.send({"version": "2.0","template": {"outputs": [{ "textCard": {"title": "학생회비 납부자가 아닙니다.","description": description,"buttons": [{ "label": "처음으로","action": "block","messageText": "처음으로"}]}}]}});
    return;
  }

  if (isAvailableTime()){
    description = `평일 9시부터 22시까지 당일 예약만 가능합니다.`;
    res.send({"version": "2.0","template": {"outputs": [{ "textCard": {"title": "현재 예약할 수 없는 시간입니다.","description": description,"buttons": [{ "label": "처음으로","action": "block","messageText": "처음으로"}]}}]}});
    return;
  }
  if (isWrongHours(start_time, end_time)){
    description = `- 방 종류 : ${room_type}\n- 신청한 시간 : ${time_string}\n\n처음부터 다시 시도해주세요. 종료 시각이 시작 시각 이전으로 작성되었는지 확인해주세요.`;
    res.send({"version": "2.0","template": {"outputs": [{ "textCard": {"title": "30분부터 최대 4시간까지 신청 가능합니다.","description": description,"buttons": [{ "label": "처음으로","action": "block","messageText": "처음으로"}]}}]}});
    return;
  }
 if (await checkOverlap(databaseId, start_time, end_time, room_type)) {
    description = `- 방 종류 : ${room_type}\n- 신청한 시간 : ${time_string}\n\n예약 현황을 조회하시고, 비어있는 시간에 다시 신청해주세요.`;
    res.send({"version": "2.0","template": {"outputs": [{ "textCard": {"title": "해당 일시에 겹치는 예약이 있습니다.","description": description,"buttons": [{ "label": "처음으로","action": "block","messageText": "처음으로"}]}}]}});
    return;
  }
  const reserve_code = await generateReserveCode(room_type);
  const hiddenName = hideMiddleChar(client_info.name);
  description = `- 방 종류 : ${room_type}\n- 예약 번호 : ${reserve_code}\n- 대여 시간 : ${time_string}\n- 신청자 : ${hiddenName}\n- 총 인원 : ${total_number} \n\n사용 후 정리 및 청소를 해주시길 바랍니다. 안내 및 준수 사항 미확인으로 생기는 문제는 책임지지 않으며, 추후 대여가 제한될 수 있습니다.`;
  res.send({"version": "2.0","template": {"outputs": [{ "textCard": {"title": "성공적으로 대여하였습니다.","description": description,"buttons": [{ "label": "처음으로","action": "block","messageText": "처음으로"}]}}]}});
  return await addToNotion(databaseId, room_type, time_string ,reserve_code, hiddenName, client_info, total_number, kakao_id);
}

async function addToNotion(databaseId, room_type, time_string, reserve_code, hiddenName, client_info, total_number, kakao_id) {
  await notion.pages.create({
      parent: { database_id: databaseId },
      properties: {
        '방 종류': {
          "type": "multi_select",
          "multi_select": [{ "name": room_type }]
        },
        '신청자':{
          "type": "title",
          "title": [{ "type": "text", "text": { "content": hiddenName } }]
        },
        '대여 시간': {
          "type": "rich_text",
          "rich_text": [{ "type": "text", "text": { "content": time_string } }]
        },
        '예약 번호': {
          "type": "rich_text",
          "rich_text": [{ "type": "text", "text": { "content": reserve_code } }]
        }
      }
  });

  await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_LOG_ID },
      properties: {
        '요청': {
          "type": "multi_select",
          "multi_select": [{ "name": "reserve" }]
        },
        '예약 번호': {
          "type": "rich_text",
          "rich_text": [{ "type": "text", "text": { "content": reserve_code } }]
        },
        '방 종류': {
          "type": "multi_select",
          "multi_select": [{ "name": room_type }]
        },
        '대여 시간': {
          "type": "rich_text",
          "rich_text": [{ "type": "text", "text": { "content": time_string } }]
        },
        '신청자 이름':{
          "type": "title",
          "title": [{ "type": "text", "text": { "content": client_info.name } }]
        },
        '신청자 학번': {
          "type": "rich_text",
          "rich_text": [{ "type": "text", "text": { "content": client_info.id } }]
        },
        '신청자 전화번호': {
          "type": "rich_text",
          "rich_text": [{ "type": "text", "text": { "content": client_info.phone } }]
        },
        '총 인원수': {
          "type": "rich_text",
          "rich_text": [{ "type": "text", "text": { "content": total_number } }]
        },
        'kakao id': {
          "type": "rich_text",
          "rich_text": [{ "type": "text", "text": { "content": kakao_id } }]
        }
        
      }
  });
  return console.log(`[SUCCESS] Reserved successfully : ${reserve_code}`);
}

function timeStringToArray(timeString) {
  var splitString = timeString.split(":");
  var timeArray = splitString.map(function(timePart) {
      return parseInt(timePart, 10);
  });
  return timeArray;
}

function getCurrentTime() {
  var now = new Date();
  now.setHours(now.getUTCHours() + 9);
  var hours = now.getHours();
  var minutes = now.getMinutes();
  return [hours, minutes];
}

function getTimeInterval(timeArray1, timeArray2) {
  var time1InMinutes = timeArray1[0] * 60 + timeArray1[1];
  var time2InMinutes = timeArray2[0] * 60 + timeArray2[1];
  var intervalInMinutes = time2InMinutes - time1InMinutes;
  return intervalInMinutes;
}

async function reserveStartTimeCheck (reqBody, res) {
  var startTime = timeStringToArray(reqBody.value.origin.slice(0, 5));
  var currentTime = getCurrentTime();
  var intervalInMinutes = getTimeInterval(currentTime, startTime);

  if (intervalInMinutes < -30) {
    console.log(`[FAILED] Not available for 30 min ago : ${startTime}`);
    res.send({"status": "FAIL"});
    return;
  }
  else {
    console.log(`[SUCCESS] Successfully Validated : ${startTime}`);
    res.send({"status": "SUCCESS"});
    return;
  }
}

async function reserveClientInfoCheck (reqBody, res) {
  const str = reqBody.value.origin;
  const cleaned = str.replace(/[\s-]/g, '');
  const parts = cleaned.split(',');
  if (parts.length !== 3) {
    console.log(`[FAILED] Invalid client info : ${str}`);
    return res.send({"status": "FAIL" });
  }
  else{
    console.log(`[SUCCESS] Successfully Validated : ${str}`);
    return res.send({"status": "SUCCESS" });
  }
    
}

function parseClientInfo(str) {
  const cleaned = str.replace(/[\s-]/g, '');
  const parts = cleaned.split(',');
  return {
    name: parts[0],
    id: parts[1],
    phone: parts[2]
  }; 
}

function hideMiddleChar(str) {
  let chars = Array.from(str);
  const middleIndex = Math.floor(chars.length / 2);
  chars[middleIndex] = '*';
  return chars.join('');
}

async function checkOverlap(databaseId, start_time, end_time, room_type) {
  var now = new Date();
  now.setHours(now.getHours() + 9);
  var today = now.toISOString().split("T")[0];
  const existingReservations = await notion.databases.query({
    database_id: databaseId,
    filter: {
      and: [
        {
          timestamp: "created_time",
          created_time: {
            equals: today,
          },
        },
        {
          property: "방 종류",
          multi_select: {
            contains: room_type,
          },
        },
      ],
    },
  });
  if (existingReservations.results.length === 0) {
    return false;
  }
  else {
    for (let i = 0; i < existingReservations.results.length; i++) {
      let reservation = existingReservations.results[i];
      let time = reservation.properties['대여 시간'].rich_text[0].plain_text;
      let partedTime = time.split('-');
      let reservationStart = timeStringToArray(partedTime[0]);
      let reservationEnd  = timeStringToArray(partedTime[1]);

      let startTime = timeStringToArray(start_time.slice(0, 5));
      let endTime = timeStringToArray(end_time.slice(0, 5));
      if (getTimeInterval(startTime,reservationStart) <= 0 && getTimeInterval(startTime, reservationEnd) > 0) {
        return true;
      }
      else if (getTimeInterval(endTime, reservationStart) < 0 && getTimeInterval(endTime, reservationEnd) >= 0) {
        return true;
      }
      else if (getTimeInterval(startTime, reservationStart) >= 0 && getTimeInterval(endTime, reservationEnd) <= 0) {
        return true;
      }
    }
    return false;
  }
}

function isWrongHours(start_time, end_time) {
  let start = timeStringToArray(start_time);
  let end = timeStringToArray(end_time);
  let diff = getTimeInterval(start,end);
  return diff > 240 || diff <= 0;
}

function isAvailableTime() {
  var date = new Date();
  date.setHours(date.getHours() + 9); 
  var hour = date.getUTCHours(); 
  var day = date.getUTCDay();
  if (hour <= 8 || hour >= 22 || day === 0 || day === 6) {
      return true;
  } else {
      return false;
  }
}

function isNotPayer(name, id){
  return false;
}

async function generateReserveCode(room_type){
  const room_codes = {
    '01BLUE': 100000,
    '02GRAY': 200000,
    '03SILVER': 300000,
    '04GOLD': 400000,
    'GLAB1': 500000,
    'GLAB2': 600000,
    'CHARGER': 700000
  }
  let reserve_code = room_codes[room_type] + Math.floor(Math.random() * 90000) + 10000;
  let str_code = reserve_code.toString();

  const response = await notion.databases.query({
    database_id: process.env.NOTION_DATABASE_LOG_ID,
    filter: {
      property: "예약 번호",
      rich_text: {
        equals: str_code,
      },
    },
  });

  if (response.results.length > 0) {
    return generateReserveCode(room_type);
  }
  
  return str_code;
}


async function reserveCancel(reqBody, res){
  const reserve_code = reqBody.action.params.reserve_code;
  const kakao_id = reqBody.userRequest.user.id;

  let databaseId;
  if (['1', '2', '3', '4'].includes(reserve_code[0])) {
    databaseId = process.env.NOTION_DATABASE_NML_ID;;
  } else if (['5', '6'].includes(reserve_code[0])) {
    databaseId = process.env.NOTION_DATABASE_GLAB_ID;
  }

  const logResponse = await notion.databases.query({
    database_id: process.env.NOTION_DATABASE_LOG_ID,
    filter: {
      and: [
        {
          property: "예약 번호",
          rich_text: {
            equals: reserve_code,
          },
        },
        {
          property: "요청",
          multi_select: {
            does_not_contain: 'cancel',
          },
        },
      ],
    },
  });

  if (logResponse.results.length === 0) {
    console.log(`[FAILED] Reservation code that does not exist : ${reserve_code}`);
    description = `다시 시도해주세요.`;
    return res.send({"version": "2.0","template": {"outputs": [{ "textCard": {"title": "예약번호와 일치하는 예약이 없습니다","description": description,"buttons": [{ "label": "처음으로","action": "block","messageText": "처음으로"}]}}]}});
  }

  if (logResponse.results[0].properties["kakao id"].rich_text[0].plain_text === kakao_id){
    const response = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: "예약 번호",
        rich_text: {
          equals: reserve_code,
        },
      },
    });
    if(response.results.length === 0){
      console.log(`[FAILED] Reservation already cancelled : ${reserve_code}`);
      description = `다시 시도해주세요.`;
      return res.send({"version": "2.0","template": {"outputs": [{ "textCard": {"title": "이미 취소된 예약입니다","description": description,"buttons": [{ "label": "처음으로","action": "block","messageText": "처음으로"}]}}]}});
    }
    const room_type = response.results[0].properties["방 종류"].multi_select[0].name;
    const time_string = response.results[0].properties["대여 시간"].rich_text[0].plain_text;
    const hiddenName = response.results[0].properties["신청자"].title[0].plain_text;
    
    await notion.pages.update({
      page_id: response.results[0].id,
      archived: true,
    });

    await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_LOG_ID },
      properties: {
        '요청': {
          "type": "multi_select",
          "multi_select": [{ "name": "cancel" }]
        },
        '예약 번호': {
          "type": "rich_text",
          "rich_text": [{ "type": "text", "text": { "content": reserve_code } }]
        }
      }
    });

    description = `- 방 종류 : ${room_type}\n- 예약 번호 : ${reserve_code}\n- 대여 시간 : ${time_string}\n- 신청자 : ${hiddenName}`;
    return res.send({"version": "2.0","template": {"outputs": [{ "textCard": {"title": "공간 대여를 취소했습니다","description": description,"buttons": [{ "label": "처음으로","action": "block","messageText": "처음으로"}]}}]}});
  } else {

    console.log(`[FAILED] Reservation by another person : ${reserve_code}`);
    description = `신청자의 카카오톡 계정으로 취소를 진행해주세요.`;
    return res.send({"version": "2.0","template": {"outputs": [{ "textCard": {"title": "신청자 본인이 아닙니다","description": description,"buttons": [{ "label": "처음으로","action": "block","messageText": "처음으로"}]}}]}});
  }
}

async function reserveCodeCheck (reqBody, res) {
  const reserve_code = reqBody.value.origin;
  if (['1', '2', '3', '4', '5', '6'].includes(reserve_code[0]) && reserve_code.length === 6 && !isNaN(reserve_code)) {
    console.log(`[SUCCESS] Successfully Validated : ${reserve_code}`);
    return res.send({"status": "SUCCESS" });
  }
  else{
    console.log(`[FAILED] Invalid reserve code : ${reserve_code}`);
    return res.send({"status": "FAIL" });
  }
}


const port = process.env.PORT || 8000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});