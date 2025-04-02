const v8 = require('v8');
const process = require('process');
const { EventEmitter } = require('events');

class MemoryManager extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = {
            heapSizeMB: config.heapSizeMB || 4096,
            gcInterval: config.gcInterval || 60000,        // 1 minute
            workerTimeout: config.workerTimeout || 20000,  // 20 seconds
            monitorInterval: config.monitorInterval || 15000, // 10 seconds
            heapUsageThreshold: config.heapUsageThreshold || 0.7,  // 80%
            debugMode: config.debugMode || false
        };

        this.memoryInterval = null;
        this.workers = new Set();
        this.lastGC = Date.now();
        this.isRunning = false;
        this.state = {
            heapUsed: 0,
            heapTotal: 0,
            external: 0,
            arrayBuffers: 0
        };
    }

    start() {
        if (this.isRunning) {
            this.log('Memory manager is already running');
            return;
        }

        try {
            // Configure heap size
            v8.setFlagsFromString(`--max-old-space-size=${this.config.heapSizeMB}`);
            
            // Start memory monitoring
            this.memoryInterval = setInterval(() => {
                this.checkMemoryUsage();
            }, this.config.monitorInterval);

            // Set up event listeners
            process.on('warning', this.handleProcessWarning.bind(this));
            
            this.isRunning = true;
            this.log('Memory manager started');
            this.emit('started');
        } catch (error) {
            this.log('Error starting memory manager:', error);
            throw error;
        }
    }

    checkMemoryUsage() {
        try {
            const used = process.memoryUsage();
            
            this.state = {
                heapUsed: Math.round(used.heapUsed / 1024 / 1024),
                heapTotal: Math.round(used.heapTotal / 1024 / 1024),
                external: Math.round(used.external / 1024 / 1024),
                arrayBuffers: Math.round(used.arrayBuffers / 1024 / 1024)
            };

            this.emit('memory-usage', this.state);

            if (this.config.debugMode) {
                this.log(`Memory Usage:
                    Heap Used: ${this.state.heapUsed}MB
                    Heap Total: ${this.state.heapTotal}MB
                    External: ${this.state.external}MB
                    Array Buffers: ${this.state.arrayBuffers}MB`);
            }

            // Check if memory usage exceeds threshold
            if (this.state.heapUsed > this.config.heapSizeMB * this.config.heapUsageThreshold) {
                this.handleHighMemoryUsage();
            }
        } catch (error) {
            this.log('Error checking memory usage:', error);
            this.emit('error', error);
        }
    }

    handleHighMemoryUsage() {
        this.log('High memory usage detected');
        this.emit('high-memory');
        this.forceGC();
        this.cleanupResources();
    }

    handleProcessWarning(warning) {
        if (warning.name === 'MemoryWarning') {
            this.log('Memory warning received:', warning.message);
            this.emit('memory-warning', warning);
            this.handleHighMemoryUsage();
        }
    }

    forceGC() {
        if (!global.gc || Date.now() - this.lastGC < this.config.gcInterval) {
            return;
        }

        try {
            this.log('Forcing garbage collection');
            global.gc();
            this.lastGC = Date.now();
            this.emit('gc-completed');
        } catch (error) {
            this.log('Error during garbage collection:', error);
            this.emit('error', error);
        }
    }

    registerWorker(worker) {
        if (!worker || this.workers.has(worker)) {
            return;
        }

        this.workers.add(worker);
        this.log('Worker registered, total workers:', this.workers.size);

        // Set up worker cleanup
        worker.on('exit', () => {
            this.workers.delete(worker);
            this.log('Worker exited, remaining workers:', this.workers.size);
        });

        // Set worker timeout
        setTimeout(() => {
            if (this.workers.has(worker)) {
                this.log('Worker timeout reached, terminating worker');
                worker.terminate();
                this.workers.delete(worker);
            }
        }, this.config.workerTimeout);

        this.emit('worker-registered', worker);
    }

    cleanupResources() {
        this.cleanupWorkers();
        this.emit('cleanup-completed');
    }

    cleanupWorkers() {
        let terminatedCount = 0;
        this.workers.forEach(worker => {
            if (worker.isTerminated) {
                this.workers.delete(worker);
                terminatedCount++;
            }
        });
        
        if (terminatedCount > 0) {
            this.log(`Cleaned up ${terminatedCount} terminated workers`);
        }
    }

    getMemoryStatus() {
        return {
            ...this.state,
            workersCount: this.workers.size,
            isRunning: this.isRunning,
            lastGC: this.lastGC
        };
    }

    stop() {
        if (!this.isRunning) {
            return;
        }

        try {
            // Clear monitoring interval
            if (this.memoryInterval) {
                clearInterval(this.memoryInterval);
                this.memoryInterval = null;
            }

            // Terminate all workers
            this.workers.forEach(worker => {
                try {
                    worker.terminate();
                } catch (error) {
                    this.log('Error terminating worker:', error);
                }
            });
            this.workers.clear();

            // Force final garbage collection
            this.forceGC();

            this.isRunning = false;
            this.log('Memory manager stopped');
            this.emit('stopped');
        } catch (error) {
            this.log('Error stopping memory manager:', error);
            throw error;
        }
    }

    log(...args) {
        if (this.config.debugMode) {
            console.log('[MemoryManager]', ...args);
        }
    }
}

module.exports = MemoryManager;