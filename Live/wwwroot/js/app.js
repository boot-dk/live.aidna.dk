(() => {
    const database = new Dexie("live-monitor");
    database.version(1).stores({
        monitors: "++id, name, url, intervalSeconds",
        measurements: "++id, monitorId, timestamp"
    });

    const state = {
        monitors: [],
        latest: new Map(),
        timers: new Map(),
        table: null,
        measurementTable: null,
        chart: null,
        history: [],
        currentView: "chart",
        clockTimer: null,
        started: false
    };

    const historyLimit = 200;

    function element(id) {
        return document.getElementById(id);
    }

    function formatDate(timestamp) {
        return new Intl.DateTimeFormat("da-DK", {
            dateStyle: "short",
            timeStyle: "medium"
        }).format(new Date(timestamp));
    }

    function formatResponse(milliseconds) {
        return Number.isFinite(milliseconds) ? `${Math.round(milliseconds)} ms` : "--";
    }

    function updateClock() {
        const clock = element("live-clock");
        if (clock) {
            clock.textContent = new Intl.DateTimeFormat("da-DK", {
                dateStyle: "full",
                timeStyle: "medium"
            }).format(new Date());
        }
    }

    function showMessage(message, isError = false) {
        const messageElement = element("form-message");
        if (messageElement) {
            messageElement.textContent = message;
            messageElement.classList.toggle("is-error", isError);
        }
    }

    function makeTableData() {
        return state.monitors.map((monitor) => {
            const latest = state.latest.get(monitor.id);
            return {
                id: monitor.id,
                name: monitor.name,
                url: monitor.url,
                interval: `${monitor.intervalSeconds} sek.`,
                status: latest ? (latest.online ? "Online" : "Offline") : "Afventer",
                response: latest ? formatResponse(latest.responseTime) : "--",
                checked: latest ? formatDate(latest.timestamp) : "Ikke målt"
            };
        });
    }

    function statusFormatter(cell) {
        const status = cell.getValue();
        const className = status === "Online" ? "online" : status === "Offline" ? "offline" : "waiting";
        return `<span class="status-badge ${className}"><span></span>${status}</span>`;
    }

    function createTable() {
        state.table = new Tabulator("#monitor-table", {
            data: makeTableData(),
            layout: "fitColumns",
            responsiveLayout: "collapse",
            placeholder: "Ingen målepunkter endnu",
            columns: [
                { title: "Navn", field: "name", minWidth: 150, responsive: 0 },
                { title: "URL", field: "url", minWidth: 190, responsive: 2 },
                { title: "Status", field: "status", formatter: statusFormatter, width: 120, responsive: 0 },
                { title: "Svartid", field: "response", width: 100, responsive: 1 },
                { title: "Interval", field: "interval", width: 100, responsive: 2 },
                { title: "Senest", field: "checked", minWidth: 155, responsive: 3 },
                {
                    title: "",
                    field: "id",
                    width: 90,
                    hozAlign: "right",
                    headerSort: false,
                    formatter: () => '<button class="delete-button" type="button" title="Slet målepunkt">Slet</button>',
                    cellClick: async (_event, cell) => {
                        await deleteMonitor(cell.getRow().getData().id);
                    }
                }
            ]
        });
    }

    function updateTable() {
        if (state.table) {
            state.table.replaceData(makeTableData());
        }
        updateSummary();
    }

    function makeMeasurementData() {
        const monitorMap = new Map(state.monitors.map((monitor) => [monitor.id, monitor]));
        return [...state.history].reverse().map((measurement) => {
            const monitor = monitorMap.get(measurement.monitorId);
            return {
                timestamp: formatDate(measurement.timestamp),
                name: monitor?.name ?? "Slettet målepunkt",
                url: monitor?.url ?? "",
                status: measurement.online ? "Online" : "Offline",
                response: formatResponse(measurement.responseTime)
            };
        });
    }

    function createMeasurementTable() {
        state.measurementTable = new Tabulator("#measurement-table", {
            data: makeMeasurementData(),
            layout: "fitColumns",
            responsiveLayout: "collapse",
            pagination: true,
            paginationSize: 15,
            paginationSizeSelector: [15, 30, 50],
            placeholder: "Ingen målinger endnu",
            columns: [
                { title: "Tidspunkt", field: "timestamp", minWidth: 160, sorter: "string" },
                { title: "Webside", field: "name", minWidth: 150 },
                { title: "URL", field: "url", minWidth: 190, responsive: 2 },
                { title: "Status", field: "status", formatter: statusFormatter, width: 120 },
                { title: "Svartid", field: "response", width: 110, sorter: "number" }
            ]
        });
    }

    function updateMeasurementTable() {
        if (state.measurementTable) {
            state.measurementTable.replaceData(makeMeasurementData());
        }
    }

    function setView(view) {
        state.currentView = view;
        const chartView = element("chart-view");
        const dataView = element("data-view");
        const chartButton = element("chart-view-button");
        const dataButton = element("data-view-button");
        const chartIsVisible = view === "chart";
        chartView.hidden = !chartIsVisible;
        dataView.hidden = chartIsVisible;
        chartButton.classList.toggle("is-active", chartIsVisible);
        chartButton.setAttribute("aria-pressed", String(chartIsVisible));
        dataButton.classList.toggle("is-active", !chartIsVisible);
        dataButton.setAttribute("aria-pressed", String(!chartIsVisible));
        if (!chartIsVisible && state.measurementTable) {
            state.measurementTable.redraw(true);
        }
    }

    function updateSummary() {
        const onlineCount = state.monitors.filter((monitor) => state.latest.get(monitor.id)?.online).length;
        const responseTimes = state.monitors
            .map((monitor) => state.latest.get(monitor.id)?.responseTime)
            .filter((value) => Number.isFinite(value));
        const average = responseTimes.length > 0
            ? `${Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length)} ms`
            : "--";

        element("total-monitors").textContent = state.monitors.length;
        element("online-monitors").textContent = onlineCount;
        element("average-response").textContent = average;
        element("empty-state").hidden = state.monitors.length > 0;
    }

    function buildChart(measurements) {
        const timestamps = [...new Set(measurements.map((measurement) => measurement.timestamp))].sort((a, b) => a - b);
        const labels = timestamps.map((timestamp) => new Date(timestamp).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
        const responseValues = measurements
            .map((measurement) => measurement.responseTime)
            .filter((value) => Number.isFinite(value));
        const highestResponse = responseValues.length > 0 ? Math.max(...responseValues) : 0;
        const scaleMagnitude = 10 ** Math.floor(Math.log10(Math.max(highestResponse, 1)));
        const responseAxisMax = responseValues.length > 0
            ? Math.max(scaleMagnitude, Math.ceil((highestResponse * 1.15) / scaleMagnitude) * scaleMagnitude)
            : 100;
        const datasets = [];
        const colors = ["#4f46e5", "#0891b2", "#db2777", "#d97706", "#16a34a", "#9333ea"];

        state.monitors.forEach((monitor, index) => {
            const monitorMeasurements = new Map(
                measurements
                    .filter((measurement) => measurement.monitorId === monitor.id)
                    .map((measurement) => [measurement.timestamp, measurement])
            );
            const color = colors[index % colors.length];
            datasets.push({
                label: `${monitor.name} · svartid`,
                data: timestamps.map((timestamp) => monitorMeasurements.get(timestamp)?.responseTime ?? null),
                borderColor: color,
                backgroundColor: color,
                yAxisID: "response",
                borderWidth: 3,
                pointBackgroundColor: color,
                pointBorderColor: "#ffffff",
                pointBorderWidth: 2,
                pointRadius: 4,
                pointHoverRadius: 7,
                tension: 0.15,
                fill: false,
                spanGaps: false
            });
            datasets.push({
                label: `${monitor.name} · status`,
                data: timestamps.map((timestamp) => {
                    const measurement = monitorMeasurements.get(timestamp);
                    return measurement ? (measurement.online ? 1 : 0) : null;
                }),
                borderColor: color,
                backgroundColor: color,
                yAxisID: "status",
                borderDash: [5, 5],
                stepped: true,
                pointRadius: 2,
                spanGaps: false
            });
        });

        const chartOptions = {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: "index", intersect: false },
                plugins: {
                    legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } },
                    tooltip: { callbacks: { label: (context) => `${context.dataset.label}: ${context.dataset.yAxisID === "status" ? (context.raw === 1 ? "Online" : "Offline") : formatResponse(context.raw)}` } }
                },
                scales: {
                    response: {
                        beginAtZero: true,
                        max: responseAxisMax,
                        title: { display: true, text: "Svartid (ms)" },
                        grid: { color: "#e7eaf0" }
                    },
                    status: { min: 0, max: 1, position: "right", title: { display: true, text: "Status" }, ticks: { stepSize: 1, callback: (value) => value === 1 ? "Online" : "Offline" }, grid: { drawOnChartArea: false } },
                    x: { grid: { display: false }, ticks: { autoSkip: true, maxTicksLimit: 12 } }
                }
            };

        if (state.chart) {
            state.chart.destroy();
        }
        state.chart = new Chart(element("monitor-chart"), {
            type: "line",
            data: { labels, datasets },
            options: chartOptions
        });
    }

    async function refreshChart() {
        const measurements = await database.measurements.orderBy("timestamp").reverse().limit(historyLimit).toArray();
        state.history = measurements.reverse();
        buildChart(state.history);
        updateMeasurementTable();
    }

    async function measure(monitor) {
        const startedAt = performance.now();
        let online = false;
        try {
            const controller = new AbortController();
            const timeout = window.setTimeout(() => controller.abort(), Math.min(monitor.intervalSeconds * 1000, 15000));
            const response = await fetch(monitor.url, { method: "GET", mode: "no-cors", cache: "no-store", signal: controller.signal });
            window.clearTimeout(timeout);
            online = response.ok || response.type === "opaque" || response.status === 0;
        } catch (_error) {
            online = false;
        }

        const measurement = {
            monitorId: monitor.id,
            timestamp: Date.now(),
            online,
            responseTime: Math.max(0, Math.round(performance.now() - startedAt))
        };
        state.latest.set(monitor.id, measurement);
        await database.measurements.add(measurement);
        updateTable();
        await refreshChart();
    }

    async function clearMeasurements() {
        if (!window.confirm("Er du sikker på, at alle målinger skal slettes?")) {
            return;
        }
        await database.measurements.clear();
        state.history = [];
        state.latest.clear();
        updateTable();
        await refreshChart();
    }

    function scheduleMonitor(monitor) {
        const existingTimer = state.timers.get(monitor.id);
        if (existingTimer) {
            window.clearInterval(existingTimer);
        }
        measure(monitor);
        const timer = window.setInterval(() => measure(monitor), monitor.intervalSeconds * 1000);
        state.timers.set(monitor.id, timer);
    }

    async function loadData() {
        state.monitors = await database.monitors.toArray();
        const latestMeasurements = await database.measurements.orderBy("timestamp").reverse().toArray();
        latestMeasurements.forEach((measurement) => {
            if (!state.latest.has(measurement.monitorId)) {
                state.latest.set(measurement.monitorId, measurement);
            }
        });
        createTable();
        createMeasurementTable();
        updateSummary();
        await refreshChart();
        state.monitors.forEach(scheduleMonitor);
    }

    async function addMonitor(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const formData = new FormData(form);
        const url = String(formData.get("url")).trim();
        try {
            new URL(url);
        } catch (_error) {
            showMessage("Indtast en gyldig URL, f.eks. https://example.com.", true);
            return;
        }
        const monitor = {
            name: String(formData.get("name")).trim(),
            url,
            intervalSeconds: Number(formData.get("interval"))
        };
        monitor.id = await database.monitors.add(monitor);
        state.monitors.push(monitor);
        state.table.addData([makeTableData().find((row) => row.id === monitor.id)]);
        updateSummary();
        scheduleMonitor(monitor);
        form.reset();
        element("monitor-interval").value = "30";
        showMessage("Målepunktet er tilføjet.");
    }

    async function deleteMonitor(id) {
        const monitor = state.monitors.find((item) => item.id === id);
        if (!monitor || !window.confirm(`Slet målepunktet "${monitor.name}"?`)) {
            return;
        }
        const timer = state.timers.get(id);
        if (timer) {
            window.clearInterval(timer);
            state.timers.delete(id);
        }
        await database.monitors.delete(id);
        await database.measurements.where("monitorId").equals(id).delete();
        state.monitors = state.monitors.filter((item) => item.id !== id);
        state.latest.delete(id);
        updateTable();
        await refreshChart();
    }

    function downloadCsv() {
        database.measurements.orderBy("timestamp").toArray().then(async (measurements) => {
            const monitorNames = new Map(state.monitors.map((monitor) => [monitor.id, monitor.name]));
            const rows = [["Tidspunkt", "Navn", "URL", "Status", "Svartid (ms)"]];
            const monitorUrls = new Map(state.monitors.map((monitor) => [monitor.id, monitor.url]));
            measurements.forEach((measurement) => rows.push([
                new Date(measurement.timestamp).toISOString(),
                monitorNames.get(measurement.monitorId) ?? "Slettet målepunkt",
                monitorUrls.get(measurement.monitorId) ?? "",
                measurement.online ? "Online" : "Offline",
                measurement.responseTime
            ]));
            const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
            const link = document.createElement("a");
            link.href = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
            link.download = `live-monitor-${new Date().toISOString().slice(0, 10)}.csv`;
            link.click();
            URL.revokeObjectURL(link.href);
        });
    }

    async function start() {
        if (state.started) {
            return;
        }
        state.started = true;
        element("monitor-form").addEventListener("submit", addMonitor);
        element("download-csv").addEventListener("click", downloadCsv);
        element("clear-measurements").addEventListener("click", clearMeasurements);
        document.querySelectorAll(".view-button").forEach((button) => {
            button.addEventListener("click", () => setView(button.dataset.view));
        });
        updateClock();
        state.clockTimer = window.setInterval(updateClock, 500);
        await database.measurements.clear();
        await loadData();
    }

    function stop() {
        state.timers.forEach((timer) => window.clearInterval(timer));
        state.timers.clear();
        if (state.clockTimer) {
            window.clearInterval(state.clockTimer);
            state.clockTimer = null;
        }
        if (state.chart) {
            state.chart.destroy();
            state.chart = null;
        }
        if (state.measurementTable) {
            state.measurementTable.destroy();
            state.measurementTable = null;
        }
        state.started = false;
    }

    window.LiveMonitorApp = { start, stop };
})();
