// Application State
let yamlData = null;
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

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    centerCanvas();
    setupEventListeners();
    loadYAML();
});

function centerCanvas() {
    const rect = svgWrapper.getBoundingClientRect();
    canvasState.offsetX = rect.width / 2;
    canvasState.offsetY = rect.height / 2;
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
    document.getElementById('btn-reset-view').addEventListener('click', () => { canvasState.scale = 100; centerCanvas(); renderCanvas(); });

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
            const { lidar, type, index } = canvasState.dragVertexInfo;
            // Convert screen coordinates back to robot coordinates
            const { x, y } = screenToRobot(e.clientX, e.clientY);
            // Update YAML data
            const pts = getPolygonPoints(lidar, type);
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
        a.download = 'obstacle_stopper_params_edited.yaml';
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

function screenToRobot(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
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
}

function loadYAML() {
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
    
    // Hide Welcome Screen
    document.getElementById('welcome-screen').classList.add('hidden');
    document.getElementById('editor-workspace').classList.remove('hidden');
    
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

function getPolygonPoints(lidarName, type) {
    if (type === 'footprint') {
        return yamlData.obstacle_stopper_params.global_defaults.robot_footprint;
    }
    const lData = yamlData.obstacle_stopper_params.lidars[lidarName];
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
    Array.from(gVertices.children).forEach((el, i) => {
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

    // Render Footprint
    gFootprint.innerHTML = '';
    gVertices.innerHTML = '';
    
    const fp = yamlData.obstacle_stopper_params.global_defaults.robot_footprint;
    if (fp) {
        const pts = fp.map(p => {
            const sc = robotToScreen(p[0], p[1]);
            return `${sc.cx},${sc.cy}`;
        }).join(' ');
        const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        poly.setAttribute('points', pts);
        
        let isSelected = appState.selectedPolygon && appState.selectedPolygon.type === 'footprint';
        poly.setAttribute('class', `polygon-shape polygon-footprint ${isSelected ? 'selected' : ''}`);
        
        poly.addEventListener('click', (e) => {
            e.stopPropagation();
            appState.selectedPolygon = { lidar: 'global', type: 'footprint' };
            appState.selectedVertexIndex = null;
            renderCanvas();
            updateEditorPanel();
        });
        poly.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!isSelected) {
                appState.selectedPolygon = { lidar: 'global', type: 'footprint' };
                renderCanvas();
                updateEditorPanel();
                return;
            }
            const rCoord = screenToRobot(e.clientX, e.clientY);
            let minSubDist = Infinity;
            let insertIdx = -1;
            for (let i = 0; i < fp.length; i++) {
                const p1 = fp[i];
                const p2 = fp[(i + 1) % fp.length];
                const dist = distToSegmentSquared(rCoord, p1, p2);
                if (dist < minSubDist) {
                    minSubDist = dist;
                    insertIdx = i + 1;
                }
            }
            fp.splice(insertIdx, 0, [rCoord.x, rCoord.y]);
            saveToLocal();
            renderCanvas();
            updateEditorPanel();
        });
        
        gFootprint.appendChild(poly);
        
        if (isSelected) {
            fp.forEach((p, idx) => {
                const sc = robotToScreen(p[0], p[1]);
                const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle.setAttribute('cx', sc.cx);
                circle.setAttribute('cy', sc.cy);
                circle.setAttribute('r', '4');
                const isActiveV = appState.selectedVertexIndex === idx;
                circle.setAttribute('class', `vertex-handle${isActiveV ? ' vertex-handle-active' : ''}`);
                
                circle.addEventListener('mousedown', (e) => {
                    e.stopPropagation();
                    canvasState.dragVertexInfo = { lidar: 'global', type: 'footprint', index: idx };
                    appState.selectedVertexIndex = idx;
                    highlightActiveVertex();
                    updateEditorPanel();
                });
                circle.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    if (fp.length <= 3) return; // keep minimum 3 vertices
                    fp.splice(idx, 1);
                    appState.selectedVertexIndex = null;
                    saveToLocal();
                    renderCanvas();
                    updateEditorPanel();
                });
                
                gVertices.appendChild(circle);
            });
        }
    }
    
    // Render Lidar Fields
    gPolygons.innerHTML = '';
    
    appState.visibleLidars.forEach(lidar => {
        ['protective', 'warning'].forEach(type => {
            if (type === 'protective' && !appState.showProtective) return;
            if (type === 'warning' && !appState.showWarning) return;
            
            if (appState.hiddenFields.has(`${lidar}-${type}`)) return;
            
            const pts = getPolygonPoints(lidar, type);
            if (!pts) return;
            
            // Draw Polygon
            const screenPts = pts.map(p => {
                const sc = robotToScreen(p[0], p[1]);
                return `${sc.cx},${sc.cy}`;
            }).join(' ');
            
            const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
            poly.setAttribute('points', screenPts);
            
            let isSelected = appState.selectedPolygon && 
                             appState.selectedPolygon.lidar === lidar && 
                             appState.selectedPolygon.type === type;
                             
            poly.setAttribute('class', `polygon-shape polygon-${type} ${isSelected ? 'selected' : ''}`);
            poly.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent map drag
                appState.selectedPolygon = { lidar, type };
                appState.selectedVertexIndex = null;
                renderCanvas();
                updateEditorPanel();
            });
            poly.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                appState.hiddenFields.add(`${lidar}-${type}`);
                if (isSelected) {
                    appState.selectedPolygon = null;
                    updateEditorPanel();
                }
                renderCanvas();
            });
            poly.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!isSelected) {
                    appState.selectedPolygon = { lidar, type };
                    renderCanvas();
                    updateEditorPanel();
                    return;
                }
                const rCoord = screenToRobot(e.clientX, e.clientY);
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
            
            gPolygons.appendChild(poly);
            
            // Draw Vertices if Selected
            if (isSelected) {
                pts.forEach((p, idx) => {
                    const sc = robotToScreen(p[0], p[1]);
                    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    circle.setAttribute('cx', sc.cx);
                    circle.setAttribute('cy', sc.cy);
                    circle.setAttribute('r', '4');
                    const isActiveV = appState.selectedVertexIndex === idx;
                    circle.setAttribute('class', `vertex-handle${isActiveV ? ' vertex-handle-active' : ''}`);
                    
                    circle.addEventListener('mousedown', (e) => {
                        e.stopPropagation();
                        canvasState.dragVertexInfo = { lidar, type, index: idx };
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
                    
                    gVertices.appendChild(circle);
                });
            }
        });
    });
}

function updateEditorPanel() {
    const emptyState = document.getElementById('editor-empty-state');
    const content = document.getElementById('editor-content');
    
    if (!appState.selectedPolygon) {
        emptyState.classList.remove('hidden');
        content.classList.add('hidden');
        return;
    }
    
    emptyState.classList.add('hidden');
    content.classList.remove('hidden');
    
    const { lidar, type } = appState.selectedPolygon;
    
    if (type === 'footprint') {
        document.getElementById('editor-badge').textContent = `Robot Footprint`;
        document.getElementById('editor-badge').className = `badge bg-blue`;
        document.getElementById('threshold-container').classList.add('hidden');
        document.getElementById('standard-limits-container').classList.add('hidden');
        document.getElementById('z-limits-container').classList.add('hidden');
    } else {
        document.getElementById('editor-badge').textContent = `${lidar} - ${type}`;
        document.getElementById('editor-badge').className = `badge bg-${type === 'protective' ? 'green' : 'yellow'}`;
        document.getElementById('threshold-container').classList.remove('hidden');
        document.getElementById('standard-limits-container').classList.remove('hidden');
        document.getElementById('z-limits-container').classList.remove('hidden');
        
        const stateObj = yamlData.obstacle_stopper_params.lidars[lidar].states[appState.selectedStateCode];
        
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
        const lidarObj = yamlData.obstacle_stopper_params.lidars[lidar];
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
    
    const pts = getPolygonPoints(lidar, type);
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

function showExport() {
    if (!yamlData) return;
    const yamlString = jsyaml.dump(yamlData, {
        indent: 2,
        lineWidth: -1 // Disable line wrapping
    });
    document.getElementById('export-textarea').value = yamlString;
    document.getElementById('export-modal').classList.remove('hidden');
}
