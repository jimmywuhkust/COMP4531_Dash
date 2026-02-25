// =============================================
// GLOBAL VARIABLES
// =============================================
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

// Dynamic 3D rotation labels
let rotTextX, rotTextY, rotTextZ;


// Step source selection
let useDeviceStep = false;

// Current IMU sub-tab: '3d' | 'steps' | 'game'
let currentImuMode = '3d';


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

// =============================================
// UI & LOGGING
// =============================================
function log(msg) {
    const t = document.getElementById('terminal');
    if (!t) return;
    const time = new Date().toLocaleTimeString().split(' ')[0];
    t.innerHTML += `<div><span style="opacity:0.5">[${time}]</span> ${msg}</div>`;
    t.scrollTop = t.scrollHeight;
}

function setTab(id) {
    document.querySelectorAll('.view-section').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    
    const targetView = document.getElementById('view-' + id);
    if (targetView) targetView.classList.add('active');
    
    const btn = document.querySelector(`button[onclick="setTab('${id}')"]`);
    if (btn) btn.classList.add('active');

    // If switching away from IMU tab, stop 3D resizing
    if (id === 'imu') {
        resize3D();
    }
}

function setImuMode(mode) {
    currentImuMode = mode;
    document.querySelectorAll('.sub-btn').forEach(b => b.classList.remove('active'));
    
    const activeBtn = document.querySelector(`button[onclick="setImuMode('${mode}')"]`);
    if (activeBtn) activeBtn.classList.add('active');

    const pedo = document.getElementById('pedometer-view');
    const graphs = document.getElementById('graph-layer');
    const gameView = document.getElementById('game-view');
    const imuContent = document.getElementById('imu-content');

    // Hide everything first
    if (pedo) pedo.classList.remove('active');
    if (gameView) gameView.classList.remove('active');
    if (graphs) graphs.style.display = 'none';
    if (imuContent) imuContent.style.display = 'block'; // Default to show 3D container

    // Show only what is needed
    if (mode === 'steps') {
        if (pedo) pedo.classList.add('active');
        if (imuContent) imuContent.style.display = 'none'; // Hide 3D in steps mode
    } else if (mode === 'game') {
        if (gameView) gameView.classList.add('active');
        if (imuContent) imuContent.style.display = 'none'; // Hide 3D in game mode
        fbResizeCanvas(); // Ensure game canvas is sized right
    } else {
        // 3D Mode
        if (graphs) graphs.style.display = 'flex';
        setTimeout(resize3D, 50);
        // Restart the 3D animation loop if it was stopped
        animate();
    }
}

// =============================================
// RECALIBRATE
// =============================================
function recalibrate() {
    tPitch = 0;
    tRoll = 0;
    tYaw = 0;
    log("Recalibrated: orientation reset to zero.");
}

// =============================================
// CSV & RECORDING
// =============================================
function toggleStream() {
    // Show calibration dialog before starting
    const dialog = document.getElementById('calibDialog');
    if (dialog) {
        dialog.style.display = 'flex';
        const goBtn = document.getElementById('calibStartBtn');
        // Replace listener to avoid stacking
        const newBtn = goBtn.cloneNode(true);
        goBtn.parentNode.replaceChild(newBtn, goBtn);
        newBtn.addEventListener('click', () => {
            dialog.style.display = 'none';
            startStreamAfterCalib();
        });
    } else {
        startStreamAfterCalib();
    }
}

function closeCalibDialog() {
    const dialog = document.getElementById('calibDialog');
    if (dialog) dialog.style.display = 'none';
}

function startStreamAfterCalib() {
    const btn = document.getElementById('startBtn');
    send('START');
    if (btn) {
        btn.innerText = "Streaming...";
        btn.classList.add('btn-streaming');
    }
    // Reset orientation on start
    recalibrate();
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

// =============================================
// BLUETOOTH CORE
// =============================================
async function connect() {
    try {
        const gidVal = document.getElementById('gid').value;
        const gid = parseInt(gidVal);
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
            const ppsEl = document.getElementById('pps');
            if (ppsEl) ppsEl.innerText = `${ppsCount} PPS`;
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

// =============================================
// DATA HANDLERS (OPTIMIZED)
// =============================================
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
    if(!box) return;
    if(box.querySelector('.chat-placeholder')) box.innerHTML = '';
    const div = document.createElement('div');
    div.className = `msg ${type}`;
    div.innerText = txt;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

async function sendLoRa() {
    const input = document.getElementById('loraTxt');
    if (input && input.value) {
        await send("SEND_LORA:" + input.value);
        addChatBubble(input.value, 'out');
        input.value = "";
    }
}

async function recordAudio() {
    audioChunks = []; isRec = true;
    const recBtn = document.getElementById('recBtn');
    if (recBtn) recBtn.disabled = true;
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
        const recBtn = document.getElementById('recBtn');
        if (recBtn) recBtn.disabled = false;
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
    if (!c) return;
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

let streamTimeout; 

function handleIMU(e) {
    const v = e.target.value;
    if (v.byteLength < 24) return;

    const ax = v.getFloat32(0, true);
    const ay = v.getFloat32(4, true);
    const az = v.getFloat32(8, true);
    const gx = v.getFloat32(12, true);
    const gy = v.getFloat32(16, true);
    const gz = v.getFloat32(20, true);

    ppsCount++;

    // Watchdog to auto-reset button if stream stops
    const btn = document.getElementById('startBtn');
    if (btn && btn.innerText !== "Streaming...") {
        btn.innerText = "Streaming...";
        btn.classList.add('btn-streaming');
        targetY = 0; 
    }
    clearTimeout(streamTimeout);
    streamTimeout = setTimeout(() => { resetStreamBtn(); }, 1000);

    // --- GAME MODE (OPTIMIZATION) ---
    // In Game Mode, calculate pitch for game and update UI text, but skip heavy 3D/graph operations
    if (currentImuMode === 'game') {
        const imuPitchDeg = Math.atan2(-ax, Math.sqrt(ay * ay + az * az)) * (180 / Math.PI);
        fbHandlePitch(imuPitchDeg);
        
        // Update Text UI (still needed for sidebar display)
        const accValEl = document.getElementById('accVal');
        const gyroValEl = document.getElementById('gyroVal');
        if (accValEl) accValEl.innerText = `${ax.toFixed(2)}, ${ay.toFixed(2)}, ${az.toFixed(2)}`;
        if (gyroValEl) gyroValEl.innerText = `${gx.toFixed(2)}, ${gy.toFixed(2)}, ${gz.toFixed(2)}`;
        
        // Skip 3D math, graphs, and other heavy operations
        return; 
    }

    // --- 3D / NORMAL MODE ---
    // If we are here, we are NOT in game mode. Proceed with normal logic.
    
    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    // CSV Recording
    if (csvRecording) {
        const ts = (now - csvStartTime).toFixed(2);
        const stepEl = document.getElementById('stepBig');
        const steps = stepEl ? stepEl.innerText : '0';
        csvRows.push(`${ts},${ax.toFixed(4)},${ay.toFixed(4)},${az.toFixed(4)},${gx.toFixed(4)},${gy.toFixed(4)},${gz.toFixed(4)},${steps}`);
    }

    // Update Text UI
    const accValEl = document.getElementById('accVal');
    const gyroValEl = document.getElementById('gyroVal');
    if (accValEl) accValEl.innerText = `${ax.toFixed(2)}, ${ay.toFixed(2)}, ${az.toFixed(2)}`;
    if (gyroValEl) gyroValEl.innerText = `${gx.toFixed(2)}, ${gy.toFixed(2)}, ${gz.toFixed(2)}`;

    // Update Graphs Arrays
    accHist.push([ax, ay, az]); accHist.shift();
    gyroHist.push([gx, gy, gz]); gyroHist.shift();

    // 3D Orientation Math
    tPitch = -Math.atan2(-ax, Math.sqrt(ay * ay + az * az));
    tRoll = -Math.atan2(ay, az);
    const gyroRad = gz;
    // Yaw sign depends on current az: face-up (az>0) → +, face-down (az<0) → -
    tYaw += Math.sign(az || 1) * gyroRad * dt;

    const oriP = document.getElementById('oriPitch');
    const oriR = document.getElementById('oriRoll');
    const oriY = document.getElementById('oriYaw');
    if (oriP) oriP.innerText = (tPitch * 180 / Math.PI).toFixed(1) + '\u00B0';
    if (oriR) oriR.innerText = (tRoll * 180 / Math.PI).toFixed(1) + '\u00B0';
    if (oriY) oriY.innerText = (tYaw * 180 / Math.PI).toFixed(1) + '\u00B0';

    // Local Step Counter Logic
    if (!useDeviceStep) {
        const magnitude = Math.sqrt(ax * ax + ay * ay + az * az);
        if (magnitude > 15) {
            const stepBigEl = document.getElementById('stepBig');
            const current = stepBigEl ? parseInt(stepBigEl.innerText || '0', 10) || 0 : 0;
            updateStepDisplay(current + 1);
        }
    }
}

// =============================================
// 3D SCENE (THREE.JS)
// =============================================
let scene, camera, renderer, board3d;

function init3D() {
    const container = document.getElementById('imu-content');
    if (!container) return;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    board3d = new THREE.Group();
    board3d.position.y = 20; 
    scene.add(board3d);

    const loader = new THREE.GLTFLoader();
    // Ensure 'XIAO-nRF52840.glb' is in the SAME folder as this script
    loader.load('XIAO-nRF52840.glb', function (gltf) {
        const model = gltf.scene;
        model.scale.set(120, 120, 120);
        model.rotation.set(Math.PI / 2, 0, Math.PI / 2);
        board3d.add(model);
    }, undefined, function () {
        // Fallback box if model fails to load
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

    addAxisArrows(board3d);
    addRotationRings(board3d);

    const L = 3.5;
    rotTextX = createDynamicSprite('Roll 0.0\u00B0', '#ff3b30');
    rotTextX.position.set(0, 0, -(L + 1.0));
    board3d.add(rotTextX);

    rotTextY = createDynamicSprite('Pitch 0.0\u00B0', '#34c759');
    rotTextY.position.set(-(L + 0.8), 0.5, 0);
    board3d.add(rotTextY);

    rotTextZ = createDynamicSprite('Yaw 0.0\u00B0', '#007aff');
    rotTextZ.position.set(0, L + 0.8, 0);
    board3d.add(rotTextZ);

    camera.position.set(0, 5, 5);
    camera.lookAt(0, 0, 0);
    animate();
}

function makeArrow(dir, color, len) {
    const arrow = new THREE.ArrowHelper(
        dir.normalize(), new THREE.Vector3(0, 0, 0), len, color, len * 0.18, len * 0.1
    );
    return arrow;
}

function addAxisArrows(parent) {
    const L = 3.5;
    parent.add(makeArrow(new THREE.Vector3(0, 0, -1), 0xff3b30, L)); // X — red (Roll, toward USB)
    parent.add(makeArrow(new THREE.Vector3(-1, 0, 0), 0x34c759, L)); // Y — green (Pitch, device left)
    parent.add(makeArrow(new THREE.Vector3(0, 1, 0), 0x007aff, L));  // Z — blue (Yaw, up)
}

function makeTextSprite(text, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 32px Inter, sans-serif';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 64, 32);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.6, 0.8, 1);
    return sprite;
}

function createDynamicSprite(text, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.8, 0.7, 1);
    sprite.userData = { canvas, ctx, color, tex };
    updateSpriteText(sprite, text);
    return sprite;
}

function updateSpriteText(sprite, text) {
    const { canvas, ctx, color, tex } = sprite.userData;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 28px Inter, sans-serif';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    tex.needsUpdate = true;
}

function addRotationRings(parent) {
    const radius = 2.8;
    const segments = 64;
    const rings = [
        { axis: 'z', color: 0xff3b30 },
        { axis: 'x', color: 0x34c759 },
        { axis: 'y', color: 0x007aff },
    ];
    rings.forEach(({ axis, color }) => {
        const points = [];
        for (let i = 0; i <= segments; i++) {
            const a = (i / segments) * Math.PI * 2;
            const c = Math.cos(a) * radius;
            const s = Math.sin(a) * radius;
            if (axis === 'x') points.push(new THREE.Vector3(0, c, s));
            else if (axis === 'y') points.push(new THREE.Vector3(c, 0, s));
            else points.push(new THREE.Vector3(c, s, 0));
        }
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineDashedMaterial({
            color, transparent: true, opacity: 0.2,
            dashSize: 0.3, gapSize: 0.15
        });
        const line = new THREE.Line(geo, mat);
        line.computeLineDistances();
        parent.add(line);
    });
}

function drawGraph(cv, data, scale) {
    if (!cv) return;
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
    // OPTIMIZATION: Completely stop the 3D animation loop when not in 3D mode
    // This eliminates all overhead from Three.js rendering and graph drawing
    if (currentImuMode !== '3d') {
        // Don't schedule next frame - completely stop the loop
        // The loop will restart automatically when switching back to 3D mode via setImuMode
        return;
    }
    
    // Continue the loop only in 3D mode
    requestAnimationFrame(animate);

    if (board3d) {
        currentY += (targetY - currentY) * 0.05; 
        board3d.position.y = currentY;

        const smoothCheck = document.getElementById('smoothCheck');
        const smooth = smoothCheck ? smoothCheck.checked : true;
        if (smooth) {
            board3d.rotation.x = lerpAngle(board3d.rotation.x, tPitch, LERP);
            board3d.rotation.z = lerpAngle(board3d.rotation.z, tRoll, LERP);
            board3d.rotation.y = lerpAngle(board3d.rotation.y, tYaw, LERP);
        } else {
            board3d.rotation.x = tPitch;
            board3d.rotation.z = tRoll;
            board3d.rotation.y = tYaw;
        }
        
        if(targetY === 0) {
             board3d.position.y += Math.sin(Date.now() * 0.002) * 0.05;
        }
    }

    if (rotTextX) {
        const rollDeg = (tRoll * 180 / Math.PI).toFixed(1);
        const pitchDeg = (tPitch * 180 / Math.PI).toFixed(1);
        const yawDeg = (tYaw * 180 / Math.PI).toFixed(1);
        updateSpriteText(rotTextX, 'Roll ' + rollDeg + '\u00B0');
        updateSpriteText(rotTextY, 'Pitch ' + pitchDeg + '\u00B0');
        updateSpriteText(rotTextZ, 'Yaw ' + yawDeg + '\u00B0');
    }

    renderer.render(scene, camera);
    const accCv = document.getElementById('accCanvas');
    const gyrCv = document.getElementById('gyroCanvas');
    if (accCv) drawGraph(accCv, accHist, 5);
    if (gyrCv) drawGraph(gyrCv, gyroHist, 5.0);
}

function resize3D() {
    const c = document.getElementById('imu-content');
    if(renderer && camera && c) {
        renderer.setSize(c.clientWidth, c.clientHeight);
        camera.aspect = c.clientWidth / c.clientHeight;
        camera.updateProjectionMatrix();
    }
}

// =============================================
// FLAPPY BIRD GAME (IMU-controlled)
// =============================================
const fb = {
    canvas: null, ctx: null,
    W: 800, H: 500,

    BIRD_SIZE: 28,
    BIRD_X_FRAC: 0.18,
    PIPE_W: 55,
    PIPE_GAP: 190,
    PIPE_SPEED: 2.5, // Base speed (will be multiplied by delta time)
    PIPE_INTERVAL: 2200,
    GRAVITY: 0.22, // Base gravity (will be multiplied by delta time)
    MAX_FALL: 5.5,
    KEY_FLAP: -5.5,

    FLAP_VEL_THRESH: 4,
    FLAP_RANGE_THRESH: 15,
    FLAP_POWER_MIN: -5,
    FLAP_POWER_MAX: -10,
    FLAP_SENSITIVITY: 0.3,
    FLAP_COOLDOWN: 120,
    SWING_TIMEOUT: 300,

    // Delta time tracking for frame-rate independent updates
    lastFrameTime: 0,
    targetFPS: 60,
    frameTime: 1000 / 60, // 16.67ms per frame at 60fps

    running: false, over: false,
    score: 0, highScore: 0,
    birdY: 0, vel: 0,
    pipes: [], lastSpawn: 0, lastFlap: 0,
    isFlapping: false, flapStrength: 0,
    mode: 'simple',

    pitch: 0, lastPitch: 0, pitchVel: 0,
    swingActive: false, swingStartPitch: 0, swingStartTime: 0, swingRange: 0,
    stars: [],
    
    // Cached background gradient for performance optimization
    bgGradient: null,

    init() {
        this.canvas = document.getElementById('fbCanvas');
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        
        // Initialize frame time tracking
        this.lastFrameTime = performance.now();

        for (let i = 0; i < 40; i++) {
            this.stars.push([Math.random(), Math.random(), 0.5 + Math.random() * 1.5]);
        }

        const startBtn = document.getElementById('fbStartBtn');
        const modeBtn = document.getElementById('fbModeBtn');
        if (startBtn) startBtn.addEventListener('click', () => fb.start());
        if (modeBtn) modeBtn.addEventListener('click', () => fb.toggleMode());

        document.addEventListener('keydown', (e) => {
            const gv = document.getElementById('game-view');
            // Only handle keys if Game Tab is active
            if (!gv || !gv.classList.contains('active')) return;
            
            if (e.key === ' ' || e.key === 'ArrowUp') {
                if (this.running) {
                    const now = Date.now();
                    if (now - this.lastFlap > this.FLAP_COOLDOWN) {
                        this.vel = this.KEY_FLAP;
                        this.lastFlap = now;
                        this.isFlapping = true;
                        this.flapStrength = 0.7;
                    }
                } else {
                    this.start();
                }
                e.preventDefault();
            }
            if (e.key === 'Enter') {
                if (!this.running) this.start();
                e.preventDefault();
            }
        });

        const saved = localStorage.getItem('fbHighScore');
        if (saved) this.highScore = parseInt(saved) || 0;

        this.resize();
        this.loop();
    },

    resize() {
        if (!this.canvas) return;
        const cont = document.getElementById('game-view');
        if (!cont) return;
        this.W = cont.clientWidth || 800;
        this.H = cont.clientHeight || 500;
        this.canvas.width = this.W;
        this.canvas.height = this.H;
        const s = this.H / 500;
        this.BIRD_SIZE = Math.round(28 * s);
        this.PIPE_GAP = Math.round(190 * s);
        this.PIPE_W = Math.round(55 * s);
        // Base speeds (will be multiplied by delta time in update)
        this.PIPE_SPEED = 2.5 * s;
        this.GRAVITY = 0.22 * s;
        this.MAX_FALL = 5.5 * s;
        this.KEY_FLAP = -5.5 * s;
        this.FLAP_POWER_MIN = -5 * s;
        this.FLAP_POWER_MAX = -10 * s;
        
        // Clear cached background gradient on resize
        this.bgGradient = null;
    },

    toggleMode() {
        const btn = document.getElementById('fbModeBtn');
        const val = document.getElementById('fbModeVal');
        if (this.mode === 'simple') {
            this.mode = 'pro';
            if (val) { val.innerText = 'Pro'; val.style.color = '#ff9800'; }
            if (btn) { btn.innerText = 'Simple Mode'; btn.style.background = '#ff9800'; }
        } else {
            this.mode = 'simple';
            if (val) { val.innerText = 'Simple'; val.style.color = '#4caf50'; }
            if (btn) { btn.innerText = 'Pro Mode'; btn.style.background = '#4caf50'; }
        }
    },

    start() {
        this.running = true;
        this.over = false;
        this.score = 0;
        this.pipes = [];
        this.birdY = this.H / 2;
        this.vel = 0;
        this.lastFlap = 0;
        this.isFlapping = false;
        this.lastSpawn = Date.now();
        this.lastFrameTime = performance.now(); // Initialize frame time tracking
        const overlay = document.getElementById('fbOverlay');
        if (overlay) overlay.classList.add('hidden');
        document.getElementById('fbScore').innerText = '0';
        this.spawnPipe();
    },

    end() {
        this.running = false;
        this.over = true;
        if (this.score > this.highScore) {
            this.highScore = this.score;
            localStorage.setItem('fbHighScore', this.highScore);
        }
        document.getElementById('fbOverlayTitle').innerText = 'Game Over!';
        document.getElementById('fbOverlayScore').innerText = `Score: ${this.score}  |  Best: ${this.highScore}`;
        document.getElementById('fbStartBtn').innerText = 'Play Again';
        const overlay = document.getElementById('fbOverlay');
        if (overlay) overlay.classList.remove('hidden');
    },

    spawnPipe() {
        const minY = this.PIPE_GAP / 2 + 40;
        const maxY = this.H - this.PIPE_GAP / 2 - 40;
        this.pipes.push({ x: this.W, gapY: Math.random() * (maxY - minY) + minY, scored: false });
    },

    handlePitch(newPitch) {
        this.pitchVel = newPitch - this.lastPitch;
        this.lastPitch = this.pitch;
        this.pitch = newPitch;

        const pv = document.getElementById('fbPitchVal');
        if (pv) pv.innerText = this.pitch.toFixed(1) + '\u00B0';

        const now = Date.now();
        if (!this.swingActive && this.pitchVel < -this.FLAP_VEL_THRESH) {
            this.swingActive = true;
            this.swingStartPitch = this.lastPitch;
            this.swingStartTime = now;
            this.swingRange = 0;
        }

        if (this.swingActive) {
            this.swingRange = this.swingStartPitch - this.pitch;
            const sv = document.getElementById('fbSwingVal');
            if (sv) sv.innerText = this.swingRange.toFixed(1) + '\u00B0';

            const progress = Math.min(1, this.swingRange / this.FLAP_RANGE_THRESH);
            const fill = document.getElementById('fbBarFill');
            if (fill) {
                fill.style.width = (progress * 100) + '%';
                fill.style.background = progress >= 1 ? '#4caf50' : '#00d4ff';
            }

            if (this.swingRange >= this.FLAP_RANGE_THRESH &&
                now - this.lastFlap > this.FLAP_COOLDOWN && this.running) {
                let power;
                if (this.mode === 'simple') {
                    power = this.KEY_FLAP;
                    this.flapStrength = 0.7;
                } else {
                    const extra = this.swingRange - this.FLAP_RANGE_THRESH;
                    power = Math.max(this.FLAP_POWER_MAX, this.FLAP_POWER_MIN - extra * this.FLAP_SENSITIVITY);
                    this.flapStrength = Math.min(1, this.swingRange / 40);
                }
                this.vel = power;
                this.lastFlap = now;
                this.isFlapping = true;
                this.swingActive = false;
                this.swingRange = 0;
            }

            if (now - this.swingStartTime > this.SWING_TIMEOUT) {
                this.swingActive = false;
                this.swingRange = 0;
            }
        } else {
            const sv = document.getElementById('fbSwingVal');
            if (sv) sv.innerText = this.pitchVel.toFixed(1) + '\u00B0/f';
            const fill = document.getElementById('fbBarFill');
            if (fill) { fill.style.width = '0%'; fill.style.background = '#00d4ff'; }
        }
    },

    update() {
        if (!this.running) return;
        
        // Calculate delta time for frame-rate independent movement
        const now = performance.now();
        let deltaTime = (now - this.lastFrameTime) / this.frameTime; // Normalize to 60fps
        this.lastFrameTime = now;
        
        // Clamp delta time to prevent large jumps (e.g., tab switching)
        deltaTime = Math.min(deltaTime, 2.0); // Max 2x speed if frame drop
        
        const nowMs = Date.now();
        if (nowMs - this.lastSpawn > this.PIPE_INTERVAL) {
            this.spawnPipe();
            this.lastSpawn = nowMs;
        }
        
        // Apply gravity and movement with delta time
        this.vel += this.GRAVITY * deltaTime;
        if (this.vel > this.MAX_FALL) this.vel = this.MAX_FALL;
        this.birdY += this.vel * deltaTime;
        
        if (this.isFlapping && nowMs - this.lastFlap > 100) this.isFlapping = false;
        const birdX = this.W * this.BIRD_X_FRAC;
        
        for (let i = this.pipes.length - 1; i >= 0; i--) {
            const p = this.pipes[i];
            // Move pipes with delta time for consistent speed
            p.x -= this.PIPE_SPEED * deltaTime;
            if (!p.scored && p.x + this.PIPE_W < birdX) {
                p.scored = true;
                this.score++;
                document.getElementById('fbScore').innerText = this.score;
            }
            if (p.x + this.PIPE_W < 0) { this.pipes.splice(i, 1); continue; }
            if (this.checkCollision(p, birdX)) { this.end(); return; }
        }
        if (this.birdY <= this.BIRD_SIZE / 2 || this.birdY >= this.H - this.BIRD_SIZE / 2) {
            this.end();
        }
    },

    checkCollision(pipe, birdX) {
        const half = this.BIRD_SIZE / 2;
        const bl = birdX - half, br = birdX + half;
        const bt = this.birdY - half, bb = this.birdY + half;
        const pl = pipe.x, pr = pipe.x + this.PIPE_W;
        const gt = pipe.gapY - this.PIPE_GAP / 2;
        const gb = pipe.gapY + this.PIPE_GAP / 2;
        return (br > pl && bl < pr && (bt < gt || bb > gb));
    },

    draw() {
        const c = this.ctx, W = this.W, H = this.H;
        if (!c) return;
        
        // Cache background gradient for performance
        if (!this.bgGradient || this.bgGradient.height !== H) {
            this.bgGradient = c.createLinearGradient(0, 0, 0, H);
            this.bgGradient.addColorStop(0, '#0c1445');
            this.bgGradient.addColorStop(0.5, '#1a237e');
            this.bgGradient.addColorStop(1, '#283593');
            this.bgGradient.height = H; // Store height for cache invalidation
        }
        c.fillStyle = this.bgGradient;
        c.fillRect(0, 0, W, H);
        
        // Optimize star rendering - batch fill operations
        c.fillStyle = 'rgba(255,255,255,0.3)';
        c.beginPath();
        this.stars.forEach(([fx, fy, r]) => {
            c.moveTo(fx * W + r, fy * H);
            c.arc(fx * W, fy * H, r, 0, Math.PI * 2);
        });
        c.fill();
        
        // Draw pipes - create gradient per pipe to avoid flickering
        // (Pipe count is low, so performance impact is minimal)
        this.pipes.forEach(p => {
            const gt = p.gapY - this.PIPE_GAP / 2;
            const gb = p.gapY + this.PIPE_GAP / 2;
            
            // Create gradient aligned with pipe position to prevent flickering
            const pg = c.createLinearGradient(p.x, 0, p.x + this.PIPE_W, 0);
            pg.addColorStop(0, '#1b5e20');
            pg.addColorStop(0.5, '#4caf50');
            pg.addColorStop(1, '#1b5e20');
            
            c.fillStyle = pg;
            c.fillRect(p.x, 0, this.PIPE_W, gt);
            c.fillRect(p.x, gb, this.PIPE_W, H - gb);
            c.fillStyle = '#2e7d32';
            c.fillRect(p.x - 4, gt - 20, this.PIPE_W + 8, 20);
            c.fillRect(p.x - 4, gb, this.PIPE_W + 8, 20);
        });
        
        // Draw bird
        const bx = W * this.BIRD_X_FRAC, by = this.birdY, sz = this.BIRD_SIZE;
        const rot = Math.min(Math.PI / 4, Math.max(-Math.PI / 4, this.vel * 0.05));
        c.save();
        c.translate(bx, by);
        c.rotate(rot);
        c.shadowColor = this.isFlapping ? '#ffff00' : '#ffd700';
        c.shadowBlur = this.isFlapping ? 25 : 12;
        c.fillStyle = '#ffd700';
        c.beginPath();
        c.arc(0, 0, sz / 2, 0, Math.PI * 2);
        c.fill();
        c.shadowBlur = 0;
        c.fillStyle = '#fff';
        c.beginPath();
        c.arc(sz * 0.22, -sz * 0.14, sz * 0.22, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = '#000';
        c.beginPath();
        c.arc(sz * 0.28, -sz * 0.14, sz * 0.11, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = '#ff6600';
        c.beginPath();
        c.moveTo(sz / 2, 0);
        c.lineTo(sz / 2 + sz * 0.35, sz * 0.08);
        c.lineTo(sz / 2, sz * 0.22);
        c.fill();
        c.fillStyle = '#ffb300';
        c.beginPath();
        if (this.isFlapping) {
            c.ellipse(-sz * 0.14, -sz * 0.22, sz * 0.4, sz * 0.28, -0.5, 0, Math.PI * 2);
        } else {
            c.ellipse(-sz * 0.14, sz * 0.14, sz * 0.34, sz * 0.22, -0.3, 0, Math.PI * 2);
        }
        c.fill();
        c.restore();
        
        // Draw borders
        c.strokeStyle = '#00d4ff';
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(0, 2);
        c.lineTo(W, 2);
        c.stroke();
        c.beginPath();
        c.moveTo(0, H - 2);
        c.lineTo(W, H - 2);
        c.stroke();
    },

    loop() {
        // OPTIMIZATION: Only run loop if Game Mode is active
        if (currentImuMode === 'game') { 
            // Only update and draw if game is running (saves CPU when paused)
            if (this.running) {
            this.update(); 
            this.draw(); 
            } else if (!this.over) {
                // Draw static frame when game is not running but not over (menu state)
                this.draw();
            }
        }
        requestAnimationFrame(() => this.loop());
    }
};

function fbResizeCanvas() { fb.resize(); }
function fbHandlePitch(deg) { if (currentImuMode === 'game') fb.handlePitch(deg); }

// =============================================
// INITIALIZATION
// =============================================
document.addEventListener('DOMContentLoaded', () => {
    // 1. Init Three.js Scene
    init3D();
    
    // 2. Init Game
    fb.init();
    
    // 3. Attach Step Source Checkbox
    const stepSourceCheckbox = document.getElementById('useDeviceStep');
    if (stepSourceCheckbox) {
        stepSourceCheckbox.addEventListener('change', (e) => {
            useDeviceStep = e.target.checked;
        });
    }

    // 4. Handle Resizing
    window.addEventListener('resize', () => {
        resize3D();
        fbResizeCanvas();
    });
    
    // 5. Initial console log for debugging
    console.log("IMU Dashboard Initialized. Mode: 3D");
});
