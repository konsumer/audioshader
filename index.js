/**
 * WebGL-based audio shader processor (Shadertoy-style)
 *
 * Usage:
 *
 * import { WebGLAudioShader } from './audio-shader.js';
 *
 * const shader = new WebGLAudioShader();
 *
 * await shader.init(`
 *   vec2 mainSound(float time) {
 *     return vec2(sin(time * 440.0 * 6.28318));
 *   }
 * `);
 *
 * shader.start();
 *
 * // Update shader (re-generates entire buffer)
 * shader.setShader(`
 *   vec2 mainSound(float time) {
 *     float freq = 220.0 + sin(time) * 100.0;
 *     return vec2(sin(time * freq * 6.28318));
 *   }
 * `);
 *
 * // When done
 * shader.stop();
 * shader.dispose();
 */

export class WebGLAudioShader {
  constructor(bufferDuration = 60) {
    this.audioContext = null
    this.sourceNode = null
    this.shader = null
    this.isRunning = false
    this.bufferDuration = bufferDuration // seconds
    this.audioBuffer = null
  }

  async init(shaderCode) {
    this.audioContext = new AudioContext()

    if (shaderCode) {
      await this.setShader(shaderCode)
    }

    return this
  }

  async setShader(shaderCode) {
    const wasRunning = this.isRunning
    if (wasRunning) {
      this.stop()
    }

    if (this.shader) {
      this.shader.dispose()
    }

    // Create shader renderer
    this.shader = new WebGLShaderRenderer(shaderCode)

    // Pre-generate entire audio buffer (Shadertoy style)
    const sampleRate = this.audioContext.sampleRate
    const numSamples = Math.floor(this.bufferDuration * sampleRate)

    // Generate in chunks to avoid blocking too long
    const chunkSize = 8192
    const numChunks = Math.ceil(numSamples / chunkSize)

    const leftChannel = new Float32Array(numSamples)
    const rightChannel = new Float32Array(numSamples)

    for (let chunk = 0; chunk < numChunks; chunk++) {
      const startSample = chunk * chunkSize
      const endSample = Math.min(startSample + chunkSize, numSamples)
      const currentChunkSize = endSample - startSample

      const chunkData = this.shader.generateAudio(sampleRate, currentChunkSize, startSample / sampleRate)

      for (let i = 0; i < currentChunkSize; i++) {
        leftChannel[startSample + i] = chunkData[i * 2]
        rightChannel[startSample + i] = chunkData[i * 2 + 1]
      }

      // Yield to browser occasionally
      if (chunk % 10 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }

    // Create Web Audio buffer
    this.audioBuffer = this.audioContext.createBuffer(2, numSamples, sampleRate)
    this.audioBuffer.copyToChannel(leftChannel, 0)
    this.audioBuffer.copyToChannel(rightChannel, 1)

    if (wasRunning) {
      this.start()
    }
  }

  start() {
    if (!this.audioBuffer) {
      console.warn('No audio buffer generated yet')
      return
    }

    if (this.isRunning) {
      this.stop()
    }

    // Create buffer source node
    this.sourceNode = this.audioContext.createBufferSource()
    this.sourceNode.buffer = this.audioBuffer
    this.sourceNode.loop = true
    this.sourceNode.connect(this.audioContext.destination)
    this.sourceNode.start(0)

    this.audioContext.resume()
    this.isRunning = true
  }

  stop() {
    if (this.sourceNode) {
      this.sourceNode.stop()
      this.sourceNode.disconnect()
      this.sourceNode = null
    }
    this.isRunning = false
  }

  dispose() {
    this.stop()
    if (this.shader) {
      this.shader.dispose()
    }
    if (this.audioContext) {
      this.audioContext.close()
    }
  }
}

export class WebGLShaderRenderer {
  constructor(fragmentShader) {
    this.canvas = document.createElement('canvas')
    this.canvas.style.display = 'none'
    document.body.appendChild(this.canvas)

    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      depth: false,
      stencil: false,
      antialias: false,
      powerPreference: 'high-performance'
    })

    if (!gl) {
      throw new Error('WebGL2 required')
    }

    this.gl = gl

    // Check for float texture support
    const floatExt = gl.getExtension('EXT_color_buffer_float')
    if (!floatExt) {
      throw new Error('EXT_color_buffer_float not supported')
    }

    this.setupShader(fragmentShader)
  }

  setupShader(fragmentShader) {
    const gl = this.gl

    const vertexShaderSource = `#version 300 es
      in vec2 position;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `

    // Shadertoy-style: FragCoord.x is sample index, time is derived from it
    const fragmentShaderSource = `#version 300 es
      precision highp float;
      uniform float iSampleRate;
      uniform float iTimeOffset;
      out vec4 fragColor;
      
      ${fragmentShader}
      
      void main() {
        float time = (gl_FragCoord.x - 0.5) / iSampleRate + iTimeOffset;
        vec2 sound = mainSound(time);
        fragColor = vec4(sound, 0.0, 1.0);
      }
    `

    const vertexShader = this.compileShader(gl.VERTEX_SHADER, vertexShaderSource)
    const fragmentShaderCompiled = this.compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource)

    this.program = gl.createProgram()
    gl.attachShader(this.program, vertexShader)
    gl.attachShader(this.program, fragmentShaderCompiled)
    gl.linkProgram(this.program)

    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error('Shader link error: ' + gl.getProgramInfoLog(this.program))
    }

    gl.useProgram(this.program)

    // Setup quad
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

    const positionLoc = gl.getAttribLocation(this.program, 'position')
    gl.enableVertexAttribArray(positionLoc)
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0)

    this.sampleRateLocation = gl.getUniformLocation(this.program, 'iSampleRate')
    this.timeOffsetLocation = gl.getUniformLocation(this.program, 'iTimeOffset')
  }

  compileShader(type, source) {
    const gl = this.gl
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(shader)
      gl.deleteShader(shader)
      throw new Error('Shader compile error: ' + error)
    }

    return shader
  }

  generateAudio(sampleRate, numSamples, timeOffset = 0) {
    const gl = this.gl

    // Resize canvas to fit samples
    this.canvas.width = numSamples
    this.canvas.height = 1

    // Create or recreate framebuffer with new size
    if (this.framebuffer) {
      gl.deleteFramebuffer(this.framebuffer)
      gl.deleteTexture(this.texture)
    }

    this.texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, numSamples, 1, 0, gl.RGBA, gl.FLOAT, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

    this.framebuffer = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0)

    // Render
    gl.uniform1f(this.sampleRateLocation, sampleRate)
    gl.uniform1f(this.timeOffsetLocation, timeOffset)

    gl.viewport(0, 0, numSamples, 1)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    // Read back
    const pixelData = new Float32Array(numSamples * 4)
    gl.readPixels(0, 0, numSamples, 1, gl.RGBA, gl.FLOAT, pixelData)

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    // Extract stereo
    const audioData = new Float32Array(numSamples * 2)
    for (let i = 0; i < numSamples; i++) {
      audioData[i * 2] = pixelData[i * 4]
      audioData[i * 2 + 1] = pixelData[i * 4 + 1]
    }

    return audioData
  }

  dispose() {
    const gl = this.gl
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer)
    if (this.texture) gl.deleteTexture(this.texture)
    if (this.program) gl.deleteProgram(this.program)
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas)
    }
  }
}
