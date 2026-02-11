// --- GLOBAL VARIABLES ---
let device, server, service, ctrlChar;
let isRec = false, audioChunks = [];
let ppsCount = 0;
let lastTime = 0; // For tracking time deltas

// Data History
const HIST_LEN = 200;
const accHist = Array(HIST_LEN).fill([0, 0, 0]);
const gyroHist = Array(HIST_LEN).fill([0, 0, 0]);

// Smoothing & Rotation Variables
let tPitch = 0, tRoll = 0, tYaw = 0;
const LERP = 0.1;

// 3D Animation Vars
let targetY = 20; 
let currentY = 20;

// Step source selection
let useDeviceStep = false;

// CSV Recording
let csvRows = [];
let csvRecording = false;
let csvStartTime = 0;
let csvFilename = '';

// --- HELPER: Fix 360-degree wrap-around glitch ---
function lerpAngle(start, end, factor) {
    let diff = end - start;
    // Wrap around PI
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return start + (diff * factor);
}

// --- UI LOGIC ---
function log(msg) {
    const t = document.getElementById('terminal');
    const time = new Date().toLocaleTimeString().split(' ')[0];
    t.innerHTML += `<div><span style="opacity:0.5">[${time}]</span> ${msg}</div>`;
    t.scrollTop = t.scrollHeight;
}

function setTab(id) {
    document.querySelectorAll('.view-section').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('view-' + id).classList.add('active');
    document.querySelector(`button[onclick="setTab('${id}')"]`).classList.add('active');
    if (id === 'imu') resize3D();
}

function setImuMode(mode) {
    document.querySelectorAll('.sub-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`button[onclick="setImuMode('${mode}')"]`).classList.add('active');
    const pedo = document.getElementById('pedometer-view');
    const graphs = document.getElementById('graph-layer');
    if (mode === 'steps') {
        pedo.classList.add('active');
        graphs.style.display = 'none';
    } else {
        pedo.classList.remove('active');
        graphs.style.display = 'flex';
    }
    // Recalculate 3D canvas size after layout change
    setTimeout(resize3D, 50);
}

// Step source checkbox handler
const stepSourceCheckbox = document.getElementById('useDeviceStep');
if (stepSourceCheckbox) {
    stepSourceCheckbox.addEventListener('change', (e) => {
        useDeviceStep = e.target.checked;
    });
}

// Button States
function toggleStream() {
    const btn = document.getElementById('startBtn');
    send('START');
    btn.innerText = "Streaming...";
    btn.classList.add('btn-streaming');
    // Reset Yaw on start so it centers
    tYaw = 0;
    // Start CSV recording
    csvRows = [];
    csvRecording = true;
    csvStartTime = performance.now();
    csvFilename = '';
    const csvRow = document.getElementById('csvDownloadRow');
    if (csvRow) csvRow.style.display = 'none';
}

function resetStreamBtn() {
    const btn = document.getElementById('startBtn');
    if(btn) {
        btn.innerText = "Start Stream";
        btn.classList.remove('btn-streaming');
    }
    // Stop CSV recording and show download row if data exists
    if (csvRecording && csvRows.length > 0) {
        csvRecording = false;
        const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        csvFilename = `imu_data_${date}.csv`;
        const csvRow = document.getElementById('csvDownloadRow');
        const csvNameEl = document.getElementById('csvFileName');
        if (csvNameEl) csvNameEl.innerText = csvFilename;
        if (csvRow) csvRow.style.display = 'flex';
    } else {
        csvRecording = false;
    }
}

function downloadCSV() {
    if (csvRows.length === 0) return;
    const header = 'timestamp_ms,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,steps\n';
    const body = csvRows.join('\n') + '\n';
    const blob = new Blob([header + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = csvFilename || 'imu_data.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// --- BLUETOOTH CORE ---
async function connect() {
    try {
        const gid = parseInt(document.getElementById('gid').value);
        const hex = gid.toString(16).padStart(2, '0');
        const base = `13172b58-${hex}`;
        
        // Freq Badge
        const freq = 900 + (gid - 1);
        const badge = document.querySelector('.badge'); 
        if(badge) badge.innerText = `${freq} MHz`;

        const UUIDS = {
            svc:   `${base}40-4150-b42d-22f30b0a0499`,
            data:  `${base}41-4150-b42d-22f30b0a0499`,
            ctrl:  `${base}42-4150-b42d-22f30b0a0499`,
            step:  `${base}43-4150-b42d-22f30b0a0499`,
            audio: `${base}44-4150-b42d-22f30b0a0499`
        };

        log(`Connecting Group ${gid}...`);
        
        device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [UUIDS.svc] }],
            optionalServices: [UUIDS.svc]
        });

        device.addEventListener('gattserverdisconnected', onDisconnect);

        server = await device.gatt.connect();
        service = await server.getPrimaryService(UUIDS.svc);

        ctrlChar = await service.getCharacteristic(UUIDS.ctrl);
        await ctrlChar.startNotifications();
        ctrlChar.addEventListener('characteristicvaluechanged', handleControlData);

        const imuChar = await service.getCharacteristic(UUIDS.data);
        await imuChar.startNotifications();
        imuChar.addEventListener('characteristicvaluechanged', handleIMU);

        try {
            const stepChar = await service.getCharacteristic(UUIDS.step);
            await stepChar.startNotifications();
            stepChar.addEventListener('characteristicvaluechanged', handleStepData);
        } catch (e) { log("Step characteristic unavailable"); }

        try {
            const ac = await service.getCharacteristic(UUIDS.audio);
            await ac.startNotifications();
            ac.addEventListener('characteristicvaluechanged', handleAudio);
        } catch (e) { log("Audio unavailable"); }

        document.getElementById('connStatus').innerText = "Connected";
        document.getElementById('statusDot').classList.add('active');
        document.getElementById('conBtn').disabled = true;
        document.getElementById('disBtn').disabled = false;

        // Reset Yaw & Timer
        tYaw = 0;
        lastTime = performance.now();
        targetY = 0; 
        currentY = 15; 
        if(board3d) board3d.position.y = 15; 

        setInterval(() => {
            document.getElementById('pps').innerText = `${ppsCount} PPS`;
            ppsCount = 0;
        }, 1000);

        log("Connected!");

    } catch (e) {
        log("Error: " + e);
    }
}

function disconnect() {
    if (device && device.gatt.connected) device.gatt.disconnect();
}

function onDisconnect() {
    document.getElementById('connStatus').innerText = "Disconnected";
    document.getElementById('statusDot').classList.remove('active');
    document.getElementById('conBtn').disabled = false;
    document.getElementById('disBtn').disabled = true;
    targetY = 20;
    resetStreamBtn();
    updateStepDisplay(0);
    log("Disconnected");
}

async function send(cmd) {
    if (!ctrlChar) return;
    const data = new TextEncoder().encode(cmd);
    try {
        if (ctrlChar.properties.writeWithoutResponse) await ctrlChar.writeValueWithoutResponse(data);
        else await ctrlChar.writeValue(data);
    } catch (e) { log("Tx Error: " + e); }
}

// --- HANDLERS ---
function updateStepDisplay(steps) {
    const stepBigEl = document.getElementById('stepBig');
    const stepSideEl = document.getElementById('stepSide');
    const ringVal = document.querySelector('.ring-val');
    if (stepBigEl) stepBigEl.innerText = steps;
    if (stepSideEl) stepSideEl.innerText = steps;
    if (ringVal) ringVal.style.strokeDashoffset = 690 - (steps % 100) * 6.9;
}

function handleStepData(e) {
    if (!useDeviceStep) return;
    const v = e.target.value;
    if (v.byteLength < 2) return;
    const steps = v.getUint16(0, true);
    updateStepDisplay(steps);
}

function handleControlData(e) {
    const msg = new TextDecoder().decode(e.target.value);
    if (msg.startsWith("LORA:")) {
        addChatBubble(msg.substring(5), 'in');
    } else { log("Rx: " + msg); }
}

function addChatBubble(txt, type) {
    const box = document.getElementById('loraChat');
    if(box.querySelector('.chat-placeholder')) box.innerHTML = '';
    const div = document.createElement('div');
    div.className = `msg ${type}`;
    div.innerText = txt;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

async function sendLoRa() {
    const input = document.getElementById('loraTxt');
    if (input.value) {
        await send("SEND_LORA:" + input.value);
        addChatBubble(input.value, 'out');
        input.value = "";
    }
}

async function recordAudio() {
    audioChunks = []; isRec = true;
    document.getElementById('recBtn').disabled = true;
    document.getElementById('audioStatus').innerText = "Recording...";
    await send("REC_AUDIO");
    setTimeout(() => {
        if (isRec && audioChunks.length === 0) document.getElementById('audioStatus').innerText = "Waiting...";
    }, 4500);
}

function handleAudio(e) {
    if (!isRec) return;
    const d = new Uint8Array(e.target.value.buffer);
    if (d.length === 0) {
        isRec = false;
        document.getElementById('recBtn').disabled = false;
        document.getElementById('audioStatus').innerText = "Playing...";
        playAudio();
        return;
    }
    for (let i = 0; i < d.length; i++) audioChunks.push(d[i]);
    document.getElementById('audioStatus').innerText = `Bytes: ${audioChunks.length}`;
}

function playAudio() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = ctx.createBuffer(1, audioChunks.length, 8000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < audioChunks.length; i++) ch[i] = (audioChunks[i] - 128) / 128.0;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination); src.start();
    drawWaveform(ch);
}

function drawWaveform(data) {
    const c = document.getElementById('audioCanvas');
    const cx = c.getContext('2d');
    const w = c.width = c.clientWidth;
    const h = c.height = c.clientHeight;
    cx.clearRect(0, 0, w, h);
    cx.beginPath(); cx.strokeStyle = '#ff3b30'; cx.lineWidth = 1.5;
    const step = Math.ceil(data.length / w);
    for (let i = 0; i < w; i++) {
        const val = (data[i * step] * (h/2)) + (h/2);
        if (i === 0) cx.moveTo(i, val); else cx.lineTo(i, val);
    }
    cx.stroke();
}

let streamTimeout; // Global or outer scope variable

function handleIMU(e) {
    const v = e.target.value;
    if (v.byteLength < 24) return;
    ppsCount++;

    // --- AUTO-TOGGLE UI ON ---
    const btn = document.getElementById('startBtn');
    if (btn && btn.innerText !== "Streaming...") {
        btn.innerText = "Streaming...";
        btn.classList.add('btn-streaming');
        // Reset target height so the board "lands" when data starts
        targetY = 0; 
    }

    // --- WATCHDOG: Toggle UI off if data stops for 1 second ---
    clearTimeout(streamTimeout);
    streamTimeout = setTimeout(() => {
        resetStreamBtn();
    }, 1000);
    
    // --- 1. Parse Data ---
    const ax = v.getFloat32(0, true);
    const ay = v.getFloat32(4, true);
    const az = v.getFloat32(8, true);
    const gx = v.getFloat32(12, true);
    const gy = v.getFloat32(16, true);
    const gz = v.getFloat32(20, true);

    // --- 2. Calculate Time Delta ---
    const now = performance.now();
    const dt = (now - lastTime) / 1000; // Seconds
    lastTime = now;

    // --- CSV Recording ---
    if (csvRecording) {
        const ts = (now - csvStartTime).toFixed(2);
        const stepEl = document.getElementById('stepBig');
        const steps = stepEl ? stepEl.innerText : '0';
        csvRows.push(`${ts},${ax.toFixed(4)},${ay.toFixed(4)},${az.toFixed(4)},${gx.toFixed(4)},${gy.toFixed(4)},${gz.toFixed(4)},${steps}`);
    }

    // --- 3. Update Text ---
    document.getElementById('accVal').innerText = `${ax.toFixed(2)}, ${ay.toFixed(2)}, ${az.toFixed(2)}`;
    document.getElementById('gyroVal').innerText = `${gx.toFixed(2)}, ${gy.toFixed(2)}, ${gz.toFixed(2)}`;

    // --- 4. Update Graphs ---
    accHist.push([ax, ay, az]); accHist.shift();
    gyroHist.push([gx, gy, gz]); gyroHist.shift();

    // --- 5. 3D Orientation Calculation ---
    // Pitch/Roll from Accelerometer (Absolute)
    tPitch = -Math.atan2(-ax, Math.sqrt(ay * ay + az * az));
    tRoll = -Math.atan2(ay, az);

    // Yaw from Gyroscope Integration (Relative)
    // gz is in degrees/s, convert to radians/s for Three.js
    // Note: Axis mapping depends on chip orientation. Usually Gyro Z controls Yaw.
    const gyroRad = gz * (Math.PI / 180);
    // Integrate: angle += rate * time
    // We subtract because 3D engines often have inverted Y rotation
    tYaw -= gyroRad * dt; 

    // Local step estimation (used when device pedometer is not selected)
    if (!useDeviceStep) {
        const magnitude = Math.sqrt(ax * ax + ay * ay + az * az);
        if (magnitude > 15) {
            const stepBigEl = document.getElementById('stepBig');
            const current = stepBigEl ? parseInt(stepBigEl.innerText || '0', 10) || 0 : 0;
            updateStepDisplay(current + 1);
        }
    }
}

// --- 3D SCENE ---
let scene, camera, renderer, board3d;
const accCv = document.getElementById('accCanvas');
const gyrCv = document.getElementById('gyroCanvas');

function init3D() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    const container = document.getElementById('imu-content');
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    board3d = new THREE.Group();
    board3d.position.y = 20; 
    scene.add(board3d);

    const loader = new THREE.GLTFLoader();
    loader.load('XIAO-nRF52840.glb', function (gltf) {
        const model = gltf.scene;
        model.scale.set(120, 120, 120);
        // Correct internal rotation of the model
        model.rotation.set(Math.PI / 2, 0, Math.PI / 2);
        board3d.add(model);
    }, undefined, function () {
        const geo = new THREE.BoxGeometry(3.5, 0.2, 2);
        const mat = new THREE.MeshStandardMaterial({ color: 0xcccccc });
        board3d.add(new THREE.Mesh(geo, mat));
    });

    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dir = new THREE.DirectionalLight(0xffffff, 1);
    dir.position.set(5, 10, 7);
    scene.add(dir);
    
    const grid = new THREE.GridHelper(30, 30, 0xdddddd, 0xeeeeee);
    grid.position.y = -3;
    scene.add(grid);

    camera.position.set(0, 5, 5);
    camera.lookAt(0, 0, 0);
    animate();
}

function drawGraph(cv, data, scale) {
    const cx = cv.getContext('2d');
    const w = cv.width = cv.clientWidth;
    const h = cv.height = cv.clientHeight;
    const mid = h / 2;
    cx.clearRect(0, 0, w, h);
    cx.lineWidth = 2;
    cx.strokeStyle = '#e5e5ea';
    cx.beginPath(); cx.moveTo(0, mid); cx.lineTo(w, mid); cx.stroke();
    ['#ff3b30', '#34c759', '#007aff'].forEach((col, i) => {
        cx.beginPath(); cx.strokeStyle = col;
        data.forEach((pt, x) => {
            const y = mid - (pt[i] * scale);
            if (x === 0) cx.moveTo((x/data.length)*w, y); 
            else cx.lineTo((x/data.length)*w, y);
        });
        cx.stroke();
    });
}

function animate() {
    requestAnimationFrame(animate);

    if (board3d) {
        // Fly-In Animation
        currentY += (targetY - currentY) * 0.05; 
        board3d.position.y = currentY;

        // Rotation Smoothing with Glitch Fix
        const smooth = document.getElementById('smoothCheck').checked;
        if (smooth) {
            // Apply Accelerometer (Pitch/Roll)
            board3d.rotation.x = lerpAngle(board3d.rotation.x, tPitch, LERP);
            board3d.rotation.z = lerpAngle(board3d.rotation.z, tRoll, LERP);
            
            // Apply Gyroscope (Yaw) - Note: Yaw is usually Y-axis in 3D space
            board3d.rotation.y = lerpAngle(board3d.rotation.y, tYaw, LERP);
        } else {
            board3d.rotation.x = tPitch;
            board3d.rotation.z = tRoll;
            board3d.rotation.y = tYaw;
        }
        
        // Gentle Float (Idle)
        if(targetY === 0) {
             board3d.position.y += Math.sin(Date.now() * 0.002) * 0.05;
        }
    }

    renderer.render(scene, camera);

    if (document.getElementById('view-imu').classList.contains('active')) {
        drawGraph(accCv, accHist, 5);
        drawGraph(gyrCv, gyroHist, 5.0);
    }
}

function resize3D() {
    const c = document.getElementById('imu-content');
    if(renderer && camera && c) {
        renderer.setSize(c.clientWidth, c.clientHeight);
        camera.aspect = c.clientWidth / c.clientHeight;
        camera.updateProjectionMatrix();
    }
}
window.addEventListener('resize', resize3D);
init3D();