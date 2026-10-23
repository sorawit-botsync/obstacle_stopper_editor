// Application State
let yamlData = null;
let compareData = null;
let compareName = '';
let appState = {
    selectedStateCode: null,
    visibleLidars: new Set(),
    showProtective: true,
    showWarning: true,
    selectedPolygon: null, // { lidar: 'front_left_lidar', type: 'protective' }
    hiddenFields: new Set(),
    selectedVertexIndex: null, // index of highlighted vertex
};

// Canvas State
let canvasState = {
    scale: 100, // pixels per meter
    offsetX: 0,
    offsetY: 0,
    isDraggingMap: false,
    dragStartX: 0,
    dragStartY: 0,
    dragVertexInfo: null // { lidar, type, index }
};

// DOM Elements
const svg = document.getElementById('canvas');
const svgWrapper = document.getElementById('svg-wrapper');
const gGrid = document.getElementById('grid-group');
const gAxes = document.getElementById('axes-group');
const gFootprint = document.getElementById('footprint-group');
const gPolygons = document.getElementById('polygons-group');
const gVertices = document.getElementById('vertices-group');
const gCmpVertices = document.getElementById('cmp-vertices-group');

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    centerCanvas();
    setupEventListeners();
    loadYAML();

    // Collapsible section headers — event delegation on the editor panel
    document.getElementById('editor-panel').addEventListener('click', (e) => {
        const h4 = e.target.closest('.field-limits > h4, .vertex-list > h4');
        if (!h4) return;
        const section = h4.parentElement;
        section.classList.toggle('collapsed');
    });
});

function centerCanvas() {
    // Use the main pane (half the width while comparing)
    const rect = svg.getBoundingClientRect();
    canvasState.offsetX = rect.width / 2;
    canvasState.offsetY = rect.height / 2;
}

// Center both panes on the content and zoom so everything fits
function fitToView() {
    if (!yamlData) return;
    const pts = [];
    const addSet = (data) => {
        const params = data && data.obstacle_stopper_params;
        if (!params) return;
        (params.global_defaults?.robot_footprint || []).forEach(p => pts.push(p));
        Object.keys(params.lidars || {}).forEach(l => {
            if (!appState.visibleLidars.has(l)) return;
            const st = params.lidars[l].states?.[appState.selectedStateCode];
            if (!st) return;
            [st.protective_fields, st.warning_fields].forEach(f => {
                if (f && f[0] && f[0].points) f[0].points.forEach(p => pts.push(p));
            });
        });
    };
    addSet(yamlData);
    addSet(compareData);
    const rect = svg.getBoundingClientRect();
    if (!pts.length || !rect.width || !rect.height) {
        canvasState.scale = 100; centerCanvas(); renderCanvas();
        return;
    }
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = Math.max(maxX - minX, 0.1), spanY = Math.max(maxY - minY, 0.1);
    // X is vertical on screen, Y horizontal; leave room for toolbar/labels
    const availW = rect.width * 0.85, availH = (rect.height - 100) * 0.85;
    canvasState.scale = Math.min(availW / spanY, availH / spanX);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    canvasState.offsetX = rect.width / 2 + cy * canvasState.scale;
    canvasState.offsetY = rect.height / 2 + 40 + cx * canvasState.scale;
    document.getElementById('zoom-level').textContent = Math.round(canvasState.scale) + '%';
    renderCanvas();
}

function setupEventListeners() {
    // Zoom
    svgWrapper.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomDelta = e.deltaY > 0 ? 0.9 : 1.1;
        canvasState.scale *= zoomDelta;
        document.getElementById('zoom-level').textContent = Math.round(canvasState.scale) + '%';
        renderCanvas();
    });

    document.getElementById('btn-zoom-in').addEventListener('click', () => { canvasState.scale *= 1.2; renderCanvas(); });
    document.getElementById('btn-zoom-out').addEventListener('click', () => { canvasState.scale *= 0.8; renderCanvas(); });
    document.getElementById('btn-reset-view').addEventListener('click', () => { fitToView(); });
    window.addEventListener('resize', () => { if (compareData) { centerCanvas(); renderCanvas(); } });

    // Map Panning
    svgWrapper.addEventListener('mousedown', (e) => {
        if (e.target === svg || e.target.id === 'grid-group') {
            canvasState.isDraggingMap = true;
            canvasState.dragStartX = e.clientX - canvasState.offsetX;
            canvasState.dragStartY = e.clientY - canvasState.offsetY;
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (canvasState.isDraggingMap) {
            canvasState.offsetX = e.clientX - canvasState.dragStartX;
            canvasState.offsetY = e.clientY - canvasState.dragStartY;
            renderCanvas();
        }
        
        if (canvasState.dragVertexInfo) {
            const { lidar, type, index, side } = canvasState.dragVertexInfo;
            // Convert screen coordinates back to robot coordinates
            const { x, y } = screenToRobot(e.clientX, e.clientY, side);
            // Update YAML data
            const pts = getPolygonPoints(lidar, type, side);
            pts[index][0] = parseFloat(x.toFixed(3));
            pts[index][1] = parseFloat(y.toFixed(3));
            
            // Re-render and update panel
            renderCanvas();
            updateEditorPanel();
        }
    });

    window.addEventListener('mouseup', () => {
        if (canvasState.dragVertexInfo) {
            saveToLocal();
        }
        canvasState.isDraggingMap = false;
        canvasState.dragVertexInfo = null;
    });

    // UI Buttons
    document.getElementById('btn-load').addEventListener('click', reloadOriginalYAML);
    
    const fileInput = document.getElementById('file-input');
    const btnImport = document.getElementById('btn-import');
    if (btnImport && fileInput) {
        btnImport.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const text = ev.target.result;
                    localStorage.setItem('originalYaml', text);
                    localStorage.setItem('importedFileName', file.name);
                    showImportedFileName();
                    yamlData = jsyaml.load(text);
                    saveToLocal();
                    initUI();
                } catch (err) {
                    alert('Error parsing YAML file: ' + err);
                }
            };
            reader.readAsText(file);
            e.target.value = '';
        });
    }
    
    const btnImportLarge = document.getElementById('btn-import-large');
    if (btnImportLarge && fileInput) {
        btnImportLarge.addEventListener('click', () => fileInput.click());
    }
    document.getElementById('state-select').addEventListener('change', (e) => {
        appState.selectedStateCode = e.target.value;
        appState.selectedPolygon = null;
        renderCanvas();
        updateEditorPanel();
    });
    document.getElementById('toggle-protective').addEventListener('change', (e) => {
        appState.showProtective = e.target.checked;
        if (e.target.checked) {
            appState.hiddenFields.forEach(f => { if(f.endsWith('-protective')) appState.hiddenFields.delete(f); });
        }
        if (!e.target.checked && appState.selectedPolygon?.type === 'protective') {
            appState.selectedPolygon = null;
            updateEditorPanel();
        }
        renderCanvas();
    });
    document.getElementById('toggle-warning').addEventListener('change', (e) => {
        appState.showWarning = e.target.checked;
        if (e.target.checked) {
            appState.hiddenFields.forEach(f => { if(f.endsWith('-warning')) appState.hiddenFields.delete(f); });
        }
        if (!e.target.checked && appState.selectedPolygon?.type === 'warning') {
            appState.selectedPolygon = null;
            updateEditorPanel();
        }
        renderCanvas();
    });
    
    // Add State UI
    const addStateLidarContainer = document.getElementById('add-state-lidars-container');
    if (addStateLidarContainer) {
        addStateLidarContainer.addEventListener('change', (e) => {
            if (e.target.type === 'checkbox' && typeof updateCopyFromDropdown === 'function') {
                const checkboxes = addStateLidarContainer.querySelectorAll('input[type="checkbox"]:checked');
                const selectedLidars = Array.from(checkboxes).map(cb => cb.value);
                updateCopyFromDropdown(selectedLidars);
            }
        });
    }

    document.getElementById('btn-add-state').addEventListener('click', () => {
        const container = document.getElementById('add-state-lidars-container');
        const checkboxes = container.querySelectorAll('input[type="checkbox"]:checked');
        const selectedLidars = Array.from(checkboxes).map(cb => cb.value);
        const copyFrom = document.getElementById('add-state-copy-from').value;
        const newStateCode = document.getElementById('add-state-code').value.trim();
        
        if (selectedLidars.length === 0 || !newStateCode) {
            alert('Please select at least one lidar and enter a state code.');
            return;
        }
        
        let changed = false;
        
        selectedLidars.forEach(lidarName => {
            if (!yamlData || !yamlData.obstacle_stopper_params || !yamlData.obstacle_stopper_params.lidars[lidarName]) return;
            
            const statesObj = yamlData.obstacle_stopper_params.lidars[lidarName].states;
            if (!statesObj) return;
            
            if (statesObj[newStateCode]) {
                console.warn(`State ${newStateCode} already exists for ${lidarName}! Skipping.`);
                return;
            }
            
            const existingStates = Object.keys(statesObj).sort();
            if (existingStates.length === 0) return;
            
            let neighborCode = existingStates[existingStates.length - 1];
            if (copyFrom !== 'auto' && existingStates.includes(copyFrom)) {
                neighborCode = copyFrom;
            } else {
                const newCodeNum = parseInt(newStateCode);
                if (!isNaN(newCodeNum)) {
                    let minDiff = Infinity;
                    existingStates.forEach(code => {
                        const codeNum = parseInt(code);
                        if (!isNaN(codeNum)) {
                            const diff = Math.abs(codeNum - newCodeNum);
                            if (diff < minDiff) {
                                minDiff = diff;
                                neighborCode = code;
                            }
                        }
                    });
                }
            }
            
            const neighborState = statesObj[neighborCode];
            statesObj[newStateCode] = JSON.parse(JSON.stringify(neighborState));
            changed = true;
        });
        
        if (changed) {
            saveToLocal();
            initUI();
            
            const stateSelect = document.getElementById('state-select');
            if (Array.from(stateSelect.options).some(opt => opt.value === newStateCode)) {
                appState.selectedStateCode = newStateCode;
                stateSelect.value = newStateCode;
                renderCanvas();
                updateEditorPanel();
            }
        }
        
        document.getElementById('add-state-code').value = '';
    });
    
    document.getElementById('btn-remove-state').addEventListener('click', () => {
        const container = document.getElementById('add-state-lidars-container');
        const checkboxes = container.querySelectorAll('input[type="checkbox"]:checked');
        const selectedLidars = Array.from(checkboxes).map(cb => cb.value);
        const stateCode = document.getElementById('add-state-code').value.trim();
        
        if (selectedLidars.length === 0 || !stateCode) {
            alert('Please select at least one lidar and enter the state code to remove.');
            return;
        }
        
        if (!confirm(`Are you sure you want to remove state ${stateCode} from the selected lidars?`)) return;
        
        let changed = false;
        
        selectedLidars.forEach(lidarName => {
            if (!yamlData || !yamlData.obstacle_stopper_params || !yamlData.obstacle_stopper_params.lidars[lidarName]) return;
            const statesObj = yamlData.obstacle_stopper_params.lidars[lidarName].states;
            if (statesObj && statesObj[stateCode]) {
                delete statesObj[stateCode];
                changed = true;
            }
        });
        
        if (changed) {
            saveToLocal();
            
            if (appState.selectedStateCode === stateCode) {
                appState.selectedStateCode = null;
                appState.selectedPolygon = null;
            }
            initUI();
        }
        
        document.getElementById('add-state-code').value = '';
    });
    
    setupCompareListeners();
    document.getElementById('export-source').addEventListener('change', fillExport);

    // Export UI
    document.getElementById('btn-export').addEventListener('click', showExport);
    document.getElementById('btn-close-modal').addEventListener('click', () => document.getElementById('export-modal').classList.add('hidden'));
    document.getElementById('btn-copy-yaml').addEventListener('click', () => {
        navigator.clipboard.writeText(document.getElementById('export-textarea').value);
        alert('Copied to clipboard!');
    });
    document.getElementById('btn-download-yaml').addEventListener('click', () => {
        const text = document.getElementById('export-textarea').value;
        const blob = new Blob([text], { type: 'text/yaml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (document.getElementById('export-source').value === 'compare' && compareName) ||
            localStorage.getItem('importedFileName') || 'obstacle_stopper_params_edited.yaml';
        a.click();
    });
}

// Coordinate Transforms
// X is forward (Up on screen), Y is left (Left on screen)
function robotToScreen(x, y) {
    const rect = svg.getBoundingClientRect();
    // Assuming container is relative. Need actual offset if absolute.
    return {
        cx: canvasState.offsetX - (y * canvasState.scale),
        cy: canvasState.offsetY - (x * canvasState.scale)
    };
}

function dataOf(side) {
    return side === 'compare' ? compareData : yamlData;
}

function screenToRobot(clientX, clientY, side) {
    const rect = (side === 'compare' ? cmpSvg : svg).getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    
    // Reverse math
    const y = -(cx - canvasState.offsetX) / canvasState.scale;
    const x = -(cy - canvasState.offsetY) / canvasState.scale;
    return { x, y };
}

function sqr(x) { return x * x; }
function dist2(v, w) { return sqr(v[0] - w[0]) + sqr(v[1] - w[1]); }
function distToSegmentSquared(p, v, w) {
    const l2 = dist2(v, w);
    if (l2 === 0) return dist2([p.x, p.y], v);
    let t = ((p.x - v[0]) * (w[0] - v[0]) + (p.y - v[1]) * (w[1] - v[1])) / l2;
    t = Math.max(0, Math.min(1, t));
    return dist2([p.x, p.y], [v[0] + t * (w[0] - v[0]), v[1] + t * (w[1] - v[1])]);
}

function saveToLocal() {
    if (!yamlData) return;
    const yamlString = jsyaml.dump(yamlData, { indent: 2, lineWidth: -1 });
    localStorage.setItem('savedYaml', yamlString);
    updateComparePanel();
}

function loadYAML() {
    showImportedFileName();
    const saved = localStorage.getItem('savedYaml');
    if (saved) {
        try {
            yamlData = jsyaml.load(saved);
            initUI();
        } catch (e) {
            console.error('Error loading YAML from local storage', e);
        }
    }
}

function showImportedFileName() {
    const el = document.getElementById('imported-file-name');
    const name = localStorage.getItem('importedFileName');
    if (!el) return;
    el.textContent = name ? 'Imported: ' + name : '';
    el.title = name || '';
}

function reloadOriginalYAML() {
    if (confirm("Are you sure you want to reload the original file? All changes since your last import will be discarded.")) {
        const orig = localStorage.getItem('originalYaml');
        if (orig) {
            try {
                yamlData = jsyaml.load(orig);
                saveToLocal();
                appState.selectedPolygon = null;
                initUI();
                updateEditorPanel();
            } catch (e) {
                alert('Error parsing original YAML: ' + e);
            }
        } else {
            alert('No original file found to reload. Please import a file first.');
        }
    }
}

function updateCopyFromDropdown(selectedLidars) {
    const copySelect = document.getElementById('add-state-copy-from');
    if (!copySelect || !yamlData || !yamlData.obstacle_stopper_params) return;
    
    let existingStatesSet = new Set();
    
    if (Array.isArray(selectedLidars)) {
        selectedLidars.forEach(lidarName => {
            const lData = yamlData.obstacle_stopper_params.lidars[lidarName];
            if (lData && lData.states) {
                Object.keys(lData.states).forEach(s => existingStatesSet.add(s));
            }
        });
    } else {
        // Fallback if string is passed
        const lData = yamlData.obstacle_stopper_params.lidars[selectedLidars];
        if (lData && lData.states) {
            Object.keys(lData.states).forEach(s => existingStatesSet.add(s));
        }
    }
    
    const existingStates = Array.from(existingStatesSet).sort();
    
    const currentSelection = copySelect.value;
    
    copySelect.innerHTML = '<option value="auto">Auto (Closest Neighbor)</option>';
    existingStates.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = `Copy from: ${s}`;
        copySelect.appendChild(opt);
    });
    
    if (currentSelection === 'auto' || existingStates.includes(currentSelection)) {
        copySelect.value = currentSelection;
    }
}

function initUI() {
    if (!yamlData || !yamlData.obstacle_stopper_params || !yamlData.obstacle_stopper_params.lidars) return;
    
    const isFirstLoad = document.getElementById('editor-workspace').classList.contains('hidden');
    
    // Hide Welcome Screen
    document.getElementById('welcome-screen').classList.add('hidden');
    document.getElementById('editor-workspace').classList.remove('hidden');
    
    // Re-center now that the SVG wrapper has real dimensions
    if (isFirstLoad) {
        centerCanvas();
    }
    
    appState.selectedPolygon = null;
    if (document.getElementById('editor-content')) {
        updateEditorPanel();
    }
    
    const lidars = Object.keys(yamlData.obstacle_stopper_params.lidars);
    
    const addStateLidarContainer = document.getElementById('add-state-lidars-container');
    if (addStateLidarContainer) {
        const currentCheckboxes = addStateLidarContainer.querySelectorAll('input[type="checkbox"]:checked');
        const currentLidars = Array.from(currentCheckboxes).map(cb => cb.value);
        
        addStateLidarContainer.innerHTML = '';
        lidars.forEach(l => {
            const label = document.createElement('label');
            label.className = 'checkbox-item';
            
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = l;
            cb.checked = currentLidars.length === 0 ? true : currentLidars.includes(l);
            
            label.appendChild(cb);
            label.appendChild(document.createTextNode(l));
            addStateLidarContainer.appendChild(label);
        });
        
        const newCheckboxes = addStateLidarContainer.querySelectorAll('input[type="checkbox"]:checked');
        updateCopyFromDropdown(Array.from(newCheckboxes).map(cb => cb.value));
    }
    
    // Collect all unique states
    let statesSet = new Set();
    lidars.forEach(l => {
        const statesObj = yamlData.obstacle_stopper_params.lidars[l].states;
        if(statesObj) Object.keys(statesObj).forEach(s => statesSet.add(s));
    });
    if (compareData && compareData.obstacle_stopper_params && compareData.obstacle_stopper_params.lidars) {
        Object.values(compareData.obstacle_stopper_params.lidars).forEach(l => {
            if (l && l.states) Object.keys(l.states).forEach(s => statesSet.add(s));
        });
    }
    const states = Array.from(statesSet).sort();
    
    // Setup State Dropdown
    const stateSelect = document.getElementById('state-select');
    stateSelect.innerHTML = '';
    states.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = `State Code: ${s}`;
        stateSelect.appendChild(opt);
    });
    
    if (states.length > 0) {
        appState.selectedStateCode = states[0];
        stateSelect.value = states[0];
    }
    
    // Setup Lidar Filters
    const filtersContainer = document.getElementById('lidar-filters');
    filtersContainer.innerHTML = '';
    appState.visibleLidars.clear();
    
    lidars.forEach(l => {
        appState.visibleLidars.add(l); // Default all visible
        
        const label = document.createElement('label');
        label.className = 'checkbox-item';
        
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.value = l;
        cb.addEventListener('change', (e) => {
            if (e.target.checked) {
                appState.visibleLidars.add(l);
                appState.hiddenFields.delete(`${l}-protective`);
                appState.hiddenFields.delete(`${l}-warning`);
            } else {
                appState.visibleLidars.delete(l);
            }
            renderCanvas();
        });
        
        label.appendChild(cb);
        label.appendChild(document.createTextNode(l));
        filtersContainer.appendChild(label);
    });
    
    renderCanvas();
}

function getPolygonPoints(lidarName, type, side = 'main') {
    const data = dataOf(side);
    if (!data) return null;
    if (type === 'footprint') {
        return data.obstacle_stopper_params.global_defaults?.robot_footprint;
    }
    const lData = data.obstacle_stopper_params.lidars[lidarName];
    if(!lData || !lData.states || !lData.states[appState.selectedStateCode]) return null;
    
    const stateObj = lData.states[appState.selectedStateCode];
    const fields = type === 'protective' ? stateObj.protective_fields : stateObj.warning_fields;
    
    if (fields && fields.length > 0 && fields[0].points) {
        return fields[0].points;
    }
    return null;
}

// Lightweight update: just restyle existing vertex circles without recreating them
function highlightActiveVertex() {
    const g = appState.selectedPolygon?.side === 'compare' ? gCmpVertices : gVertices;
    Array.from(g.children).forEach((el, i) => {
        const isActive = appState.selectedVertexIndex === i;
        el.setAttribute('class', `vertex-handle${isActive ? ' vertex-handle-active' : ''}`);
    });
}

function renderCanvas() {
    if (!yamlData) return;
    
    // Render Axes
    const xAxis = document.getElementById('axis-x');
    const yAxis = document.getElementById('axis-y');
    const oLabel = document.getElementById('label-origin');
    const xLabel = document.getElementById('label-x');
    const yLabel = document.getElementById('label-y');
    
    // Screen coords for axes
    const origin = robotToScreen(0, 0);
    const xEnd = robotToScreen(5, 0); // 5 meters front
    const yEnd = robotToScreen(0, 5); // 5 meters left
    
    xAxis.setAttribute('x1', origin.cx); xAxis.setAttribute('y1', origin.cy);
    xAxis.setAttribute('x2', xEnd.cx); xAxis.setAttribute('y2', xEnd.cy);
    
    yAxis.setAttribute('x1', origin.cx); yAxis.setAttribute('y1', origin.cy);
    yAxis.setAttribute('x2', yEnd.cx); yAxis.setAttribute('y2', yEnd.cy);
    
    oLabel.setAttribute('x', origin.cx + 5); oLabel.setAttribute('y', origin.cy - 5);
    xLabel.setAttribute('x', xEnd.cx + 5); xLabel.setAttribute('y', xEnd.cy - 5);
    yLabel.setAttribute('x', yEnd.cx + 5); yLabel.setAttribute('y', yEnd.cy - 5);

    renderPane('main');
    renderCompareCanvas();
    if (!canvasState.dragVertexInfo) updateComparePanel();
}

// Render footprint, lidar fields and (for the selected one) vertex handles of one side
function renderPane(side) {
    const data = dataOf(side);
    const isCmp = side === 'compare';
    const gF = isCmp ? document.getElementById('cmp-footprint-group') : gFootprint;
    const gP = isCmp ? document.getElementById('cmp-polygons-group') : gPolygons;
    const gV = isCmp ? gCmpVertices : gVertices;
    gF.innerHTML = '';
    gP.innerHTML = '';
    gV.innerHTML = '';
    if (!data) return;

    const sel = appState.selectedPolygon;
    const selOnSide = sel && (sel.side || 'main') === side;
    const select = (lidar, type) => {
        appState.selectedPolygon = { lidar, type, side };
    };

    // Shared interaction wiring for a polygon + its points array
    const wirePolygon = (poly, pts, lidar, type, isSelected) => {
        poly.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent map drag
            select(lidar, type);
            appState.selectedVertexIndex = null;
            renderCanvas();
            updateEditorPanel();
        });
        if (type !== 'footprint') {
            poly.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                appState.hiddenFields.add(`${lidar}-${type}`);
                if (isSelected) {
                    appState.selectedPolygon = null;
                    updateEditorPanel();
                }
                renderCanvas();
            });
        }
        poly.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!isSelected) {
                select(lidar, type);
                renderCanvas();
                updateEditorPanel();
                return;
            }
            const rCoord = screenToRobot(e.clientX, e.clientY, side);
            let minSubDist = Infinity;
            let insertIdx = -1;
            for (let i = 0; i < pts.length; i++) {
                const p1 = pts[i];
                const p2 = pts[(i + 1) % pts.length];
                const dist = distToSegmentSquared(rCoord, p1, p2);
                if (dist < minSubDist) {
                    minSubDist = dist;
                    insertIdx = i + 1;
                }
            }
            pts.splice(insertIdx, 0, [rCoord.x, rCoord.y]);
            saveToLocal();
            renderCanvas();
            updateEditorPanel();
        });
    };

    const drawVertices = (pts, lidar, type) => {
        pts.forEach((p, idx) => {
            const sc = robotToScreen(p[0], p[1]);
            const circle = document.createElementNS(SVG_NS, 'circle');
            circle.setAttribute('cx', sc.cx);
            circle.setAttribute('cy', sc.cy);
            circle.setAttribute('r', '4');
            const isActiveV = appState.selectedVertexIndex === idx;
            circle.setAttribute('class', `vertex-handle${isActiveV ? ' vertex-handle-active' : ''}`);
            
            circle.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                canvasState.dragVertexInfo = { lidar, type, index: idx, side };
                appState.selectedVertexIndex = idx;
                highlightActiveVertex();
                updateEditorPanel();
            });
            circle.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                if (pts.length <= 3) return; // keep minimum 3 vertices
                pts.splice(idx, 1);
                appState.selectedVertexIndex = null;
                saveToLocal();
                renderCanvas();
                updateEditorPanel();
            });
            gV.appendChild(circle);
        });
    };

    // Footprint
    const fp = data.obstacle_stopper_params.global_defaults?.robot_footprint;
    if (fp) {
        const poly = document.createElementNS(SVG_NS, 'polygon');
        poly.setAttribute('points', fp.map(p => {
            const sc = robotToScreen(p[0], p[1]);
            return `${sc.cx},${sc.cy}`;
        }).join(' '));
        const isSelected = selOnSide && sel.type === 'footprint';
        poly.setAttribute('class', `polygon-shape polygon-footprint ${isSelected ? 'selected' : ''}`);
        wirePolygon(poly, fp, 'global', 'footprint', isSelected);
        gF.appendChild(poly);
        if (isSelected) drawVertices(fp, 'global', 'footprint');
    }

    // Lidar Fields
    appState.visibleLidars.forEach(lidar => {
        ['protective', 'warning'].forEach(type => {
            if (type === 'protective' && !appState.showProtective) return;
            if (type === 'warning' && !appState.showWarning) return;
            if (appState.hiddenFields.has(`${lidar}-${type}`)) return;
            
            const pts = getPolygonPoints(lidar, type, side);
            if (!pts) return;
            
            const poly = document.createElementNS(SVG_NS, 'polygon');
            poly.setAttribute('points', pts.map(p => {
                const sc = robotToScreen(p[0], p[1]);
                return `${sc.cx},${sc.cy}`;
            }).join(' '));
            const isSelected = selOnSide && sel.lidar === lidar && sel.type === type;
            poly.setAttribute('class', `polygon-shape polygon-${type} ${isSelected ? 'selected' : ''}`);
            wirePolygon(poly, pts, lidar, type, isSelected);
            gP.appendChild(poly);
            
            if (isSelected) drawVertices(pts, lidar, type);
        });
    });
}

function updateEditorPanel() {
    const emptyState = document.getElementById('editor-empty-state');
    const content = document.getElementById('editor-content');
    const vertexEmptyState = document.getElementById('vertex-empty-state');
    const vertexPanelContent = document.getElementById('vertex-panel-content');
    
    if (!appState.selectedPolygon) {
        emptyState.classList.remove('hidden');
        content.classList.add('hidden');
        vertexEmptyState.classList.remove('hidden');
        vertexPanelContent.classList.add('hidden');
        return;
    }
    
    emptyState.classList.add('hidden');
    content.classList.remove('hidden');
    vertexEmptyState.classList.add('hidden');
    vertexPanelContent.classList.remove('hidden');
    
    const { lidar, type } = appState.selectedPolygon;
    const side = appState.selectedPolygon.side || 'main';
    const sideTag = side === 'compare' ? ' (compare)' : '';
    
    if (type === 'footprint') {
        document.getElementById('editor-badge').textContent = `Robot Footprint${sideTag}`;
        document.getElementById('editor-badge').className = `badge bg-blue`;
        document.getElementById('threshold-container').classList.add('hidden');
        document.getElementById('standard-limits-container').classList.add('hidden');
        document.getElementById('z-limits-container').classList.add('hidden');
    } else {
        document.getElementById('editor-badge').textContent = `${lidar} - ${type}${sideTag}`;
        document.getElementById('editor-badge').className = `badge bg-${type === 'protective' ? 'green' : 'yellow'}`;
        document.getElementById('threshold-container').classList.remove('hidden');
        document.getElementById('standard-limits-container').classList.remove('hidden');
        document.getElementById('z-limits-container').classList.remove('hidden');
        
        const stateObj = dataOf(side).obstacle_stopper_params.lidars[lidar].states[appState.selectedStateCode];
        
        // Threshold
        const thresholdInput = document.getElementById('input-obstacle-threshold');
        thresholdInput.value = stateObj.obstacle_point_threshold !== undefined ? stateObj.obstacle_point_threshold : '';
        thresholdInput.onchange = (e) => {
            const val = parseInt(e.target.value);
            if (isNaN(val)) {
                delete stateObj.obstacle_point_threshold;
            } else {
                stateObj.obstacle_point_threshold = val;
            }
            saveToLocal();
        };
        
        // Limits
        const limitsKey = type === 'protective' ? 'protective_field_sizes' : 'warning_field_sizes';
        const limits = stateObj[limitsKey] || {};
        
        const bindInput = (id, key) => {
            const el = document.getElementById(id);
            el.value = limits[key] !== undefined ? limits[key] : '';
            el.onchange = (e) => {
                const val = parseFloat(e.target.value);
                if (isNaN(val)) {
                    delete stateObj[limitsKey][key];
                } else {
                    stateObj[limitsKey][key] = val;
                }
                saveToLocal();
            };
        };
        
        bindInput('input-front-max', 'front_max');
        bindInput('input-front-min', 'front_min');
        bindInput('input-rear-max', 'rear_max');
        bindInput('input-rear-min', 'rear_min');
        bindInput('input-left-max', 'left_max');
        bindInput('input-left-min', 'left_min');
        bindInput('input-right-max', 'right_max');
        bindInput('input-right-min', 'right_min');
        
        // Z-Limits (visible only for 3D lidars)
        const lidarObj = dataOf(side).obstacle_stopper_params.lidars[lidar];
        const zContainer = document.getElementById('z-limits-container');
        
        if (lidarObj.type === '3d') {
            zContainer.classList.remove('hidden');
            const fieldKey = type === 'protective' ? 'protective_fields' : 'warning_fields';
            const fieldArr = stateObj[fieldKey];
            
            if (fieldArr && fieldArr.length > 0) {
                const fieldObj = fieldArr[0];
                const bindZInput = (id, key) => {
                    const el = document.getElementById(id);
                    el.value = fieldObj[key] !== undefined ? fieldObj[key] : '';
                    el.onchange = (e) => {
                        const val = parseFloat(e.target.value);
                        if (isNaN(val)) {
                            delete fieldObj[key];
                        } else {
                            fieldObj[key] = val;
                        }
                        saveToLocal();
                    };
                };
                bindZInput('input-min-z', 'z_min');
                bindZInput('input-max-z', 'z_max');
            }
        } else {
            zContainer.classList.add('hidden');
        }
    }
    
    // Vertices
    const vContainer = document.getElementById('vertex-inputs-container');
    vContainer.innerHTML = '';
    
    const pts = getPolygonPoints(lidar, type, side);
    if (pts) {
        pts.forEach((p, idx) => {
            const row = document.createElement('div');
            const isActive = appState.selectedVertexIndex === idx;
            row.className = `vertex-row${isActive ? ' vertex-row-active' : ''}`;
            
            const lbl = document.createElement('span');
            lbl.className = 'vertex-label';
            lbl.textContent = idx;
            if (isActive) {
                // Scroll into view after DOM is painted
                requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
            }
            
            const inpX = document.createElement('input');
            inpX.type = 'number'; inpX.step = '0.01';
            inpX.value = p[0];
            
            const inpY = document.createElement('input');
            inpY.type = 'number'; inpY.step = '0.01';
            inpY.value = p[1];
            
            const onFocus = () => {
                appState.selectedVertexIndex = idx;
                highlightActiveVertex();
                // Update row highlights without rebuilding the whole list
                vContainer.querySelectorAll('.vertex-row').forEach((r, i) => {
                    r.className = `vertex-row${i === idx ? ' vertex-row-active' : ''}`;
                });
            };
            
            inpX.addEventListener('focus', onFocus);
            inpY.addEventListener('focus', onFocus);
            
            const updatePt = () => {
                pts[idx][0] = parseFloat(inpX.value);
                pts[idx][1] = parseFloat(inpY.value);
                renderCanvas();
                saveToLocal();
            };
            
            inpX.addEventListener('change', updatePt);
            inpY.addEventListener('change', updatePt);
            
            row.appendChild(lbl);
            row.appendChild(inpX);
            row.appendChild(inpY);
            vContainer.appendChild(row);
        });
    }
}

function fillExport() {
    const src = document.getElementById('export-source').value;
    const data = src === 'compare' && compareData ? compareData : yamlData;
    document.getElementById('export-textarea').value = jsyaml.dump(data, {
        indent: 2,
        lineWidth: -1 // Disable line wrapping
    });
}

function showExport() {
    if (!yamlData) return;
    document.getElementById('export-source-row').classList.toggle('hidden', !compareData);
    if (!compareData) document.getElementById('export-source').value = 'main';
    fillExport();
    document.getElementById('export-modal').classList.remove('hidden');
}


// ---------------- Compare mode ----------------
const cmpSvg = document.getElementById('canvas-compare');
const SVG_NS = 'http://www.w3.org/2000/svg';
const FIELD_LABELS = {
    protective_fields: 'protective polygon / z-limits',
    warning_fields: 'warning polygon / z-limits',
    protective_field_sizes: 'protective sizes',
    warning_field_sizes: 'warning sizes',
    obstacle_point_threshold: 'obstacle_point_threshold'
};

function setupCompareListeners() {
    const modal = document.getElementById('compare-modal');
    const input = document.getElementById('compare-file-input');
    document.getElementById('btn-compare').addEventListener('click', () => {
        if (!yamlData) { alert('Import a main YAML file first.'); return; }
        document.getElementById('compare-main-name').textContent = localStorage.getItem('importedFileName') || 'current data';
        document.getElementById('compare-file-name').textContent = compareData ? compareName : 'none selected';
        document.getElementById('btn-compare-stop').classList.toggle('hidden', !compareData);
        modal.classList.remove('hidden');
    });
    document.getElementById('btn-close-compare-modal').addEventListener('click', () => modal.classList.add('hidden'));
    document.getElementById('btn-compare-import').addEventListener('click', () => input.click());
    document.getElementById('btn-compare-stop').addEventListener('click', () => {
        modal.classList.add('hidden');
        setCompare(null, '');
    });
    input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const data = jsyaml.load(ev.target.result);
                if (!data || !data.obstacle_stopper_params || !data.obstacle_stopper_params.lidars) {
                    alert('Invalid file: missing obstacle_stopper_params.lidars');
                    return;
                }
                modal.classList.add('hidden');
                setCompare(data, file.name);
            } catch (err) {
                alert('Error parsing YAML file: ' + err);
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    // Pan / zoom on the compare pane share the main canvas transform
    cmpSvg.addEventListener('wheel', (e) => {
        e.preventDefault();
        canvasState.scale *= e.deltaY > 0 ? 0.9 : 1.1;
        document.getElementById('zoom-level').textContent = Math.round(canvasState.scale) + '%';
        renderCanvas();
    });
    cmpSvg.addEventListener('mousedown', (e) => {
        if (e.target === cmpSvg) {
            canvasState.isDraggingMap = true;
            canvasState.dragStartX = e.clientX - canvasState.offsetX;
            canvasState.dragStartY = e.clientY - canvasState.offsetY;
        }
    });
}

function setCompare(data, name) {
    compareData = data;
    compareName = name;
    const on = !!data;
    cmpSvg.classList.toggle('hidden', !on);
    document.getElementById('compare-panel').classList.toggle('hidden', !on);
    const lm = document.getElementById('pane-label-main');
    const lc = document.getElementById('pane-label-compare');
    lm.classList.toggle('hidden', !on);
    lc.classList.toggle('hidden', !on);
    lm.textContent = 'Main: ' + (localStorage.getItem('importedFileName') || 'current');
    lc.textContent = 'Compare: ' + name;
    document.getElementById('btn-compare').textContent = on ? 'Compare: ON' : 'Compare YAML';
    centerCanvas();
    initUI();
    fitToView();
}

function cmpStatePoints(data, lidar, type, code) {
    const st = data?.obstacle_stopper_params?.lidars?.[lidar]?.states?.[code];
    if (!st) return null;
    const f = type === 'protective' ? st.protective_fields : st.warning_fields;
    return f && f.length > 0 && f[0].points ? f[0].points : null;
}

function renderCompareCanvas() {
    if (!compareData) return;
    const origin = robotToScreen(0, 0);
    const xEnd = robotToScreen(5, 0);
    const yEnd = robotToScreen(0, 5);
    const ax = document.getElementById('cmp-axis-x');
    const ay = document.getElementById('cmp-axis-y');
    ax.setAttribute('x1', origin.cx); ax.setAttribute('y1', origin.cy);
    ax.setAttribute('x2', xEnd.cx); ax.setAttribute('y2', xEnd.cy);
    ay.setAttribute('x1', origin.cx); ay.setAttribute('y1', origin.cy);
    ay.setAttribute('x2', yEnd.cx); ay.setAttribute('y2', yEnd.cy);

    renderPane('compare');

    const code = appState.selectedStateCode;
    const cmpLidars = compareData.obstacle_stopper_params.lidars;
    let anyMissing = false;
    appState.visibleLidars.forEach(lidar => {
        if (!cmpLidars[lidar] || !cmpLidars[lidar].states?.[code]) {
            if (yamlData.obstacle_stopper_params.lidars[lidar]?.states?.[code]) anyMissing = true;
        }
    });

    const msg = document.getElementById('cmp-message');
    const rect = cmpSvg.getBoundingClientRect();
    msg.setAttribute('x', rect.width / 2);
    msg.setAttribute('y', rect.height - 30);
    msg.textContent = anyMissing ? `State ${code} is missing for some lidars in compared file` : '';
}

function stableStr(v) {
    if (Array.isArray(v)) return '[' + v.map(stableStr).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStr(v[k])).join(',') + '}';
    return JSON.stringify(v);
}

function computeDiff() {
    const mL = yamlData.obstacle_stopper_params.lidars || {};
    const cL = compareData.obstacle_stopper_params.lidars || {};
    const lidars = Array.from(new Set([...Object.keys(mL), ...Object.keys(cL)])).sort();
    const codes = new Set();
    lidars.forEach(l => {
        Object.keys(mL[l]?.states || {}).forEach(c => codes.add(c));
        Object.keys(cL[l]?.states || {}).forEach(c => codes.add(c));
    });
    const result = [];
    Array.from(codes).sort().forEach(code => {
        const details = [];
        let onlyMain = 0, onlyCmp = 0, diff = 0, same = 0;
        lidars.forEach(l => {
            const m = mL[l]?.states?.[code];
            const c = cL[l]?.states?.[code];
            if (m && !c) { onlyMain++; details.push(`${l}: missing in compare`); }
            else if (!m && c) { onlyCmp++; details.push(`${l}: missing in main`); }
            else if (m && c) {
                const keys = new Set([...Object.keys(m), ...Object.keys(c)]);
                const changed = Array.from(keys).filter(k => stableStr(m[k]) !== stableStr(c[k]));
                if (changed.length) {
                    diff++;
                    details.push(`${l}: ${changed.map(k => FIELD_LABELS[k] || k).join(', ')}`);
                } else same++;
            }
        });
        let status;
        if (onlyMain && !onlyCmp && !diff && !same) status = 'missing-compare';
        else if (onlyCmp && !onlyMain && !diff && !same) status = 'missing-main';
        else if (onlyMain || onlyCmp || diff) status = 'diff';
        else status = 'same';
        result.push({ code, status, details });
    });
    return result;
}

function updateComparePanel() {
    if (!compareData || !yamlData) return;
    const list = document.getElementById('compare-list');
    const summary = document.getElementById('compare-summary');
    const items = computeDiff();
    list.innerHTML = '';

    const fpM = yamlData.obstacle_stopper_params.global_defaults?.robot_footprint;
    const fpC = compareData.obstacle_stopper_params.global_defaults?.robot_footprint;
    const fpDiff = stableStr(fpM) !== stableStr(fpC);

    const tagText = { 'diff': 'Different', 'missing-main': 'Missing in main', 'missing-compare': 'Missing in compare', 'same': 'Same' };
    const shown = items.filter(i => i.status !== 'same');
    summary.textContent = `${shown.length} of ${items.length} state codes differ` + (fpDiff ? ' · robot_footprint differs' : '');

    const addItem = (title, status, details, code) => {
        const el = document.createElement('div');
        el.className = 'cmp-item' + (code !== undefined && code === appState.selectedStateCode ? ' active' : '');
        const tagCls = status === 'diff' ? 'cmp-tag-diff' : status === 'same' ? 'cmp-tag-same' : 'cmp-tag-missing';
        el.innerHTML = `<div class="cmp-item-head"><span></span><span class="cmp-tag ${tagCls}">${tagText[status]}</span></div>`;
        el.querySelector('span').textContent = title;
        details.forEach(d => {
            const dv = document.createElement('div');
            dv.className = 'cmp-detail';
            dv.textContent = d;
            el.appendChild(dv);
        });
        if (code !== undefined) {
            el.addEventListener('click', () => {
                appState.selectedStateCode = code;
                appState.selectedPolygon = null;
                document.getElementById('state-select').value = code;
                renderCanvas();
                updateEditorPanel();
            });
        }
        list.appendChild(el);
    };

    if (fpDiff) addItem('robot_footprint', 'diff', ['global_defaults differs'], undefined);
    shown.forEach(i => addItem(`State ${i.code}`, i.status, i.details, i.code));
    if (!shown.length && !fpDiff) {
        const el = document.createElement('p');
        el.className = 'text-muted';
        el.textContent = 'Files are identical.';
        list.appendChild(el);
    }
}
