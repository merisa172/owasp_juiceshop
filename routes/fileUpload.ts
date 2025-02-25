/*
 * Copyright (c) 2014-2024 Bjoern Kimminich & the OWASP Juice Shop contributors.
 * SPDX-License-Identifier: MIT
 */

const os = require('os')
const fs = require('fs')
const challengeUtils = require('../lib/challengeUtils')
const path = require('path')
const utils = require('../lib/utils')
const { challenges } = require('../data/datacache')

const vm = require('vm')
const unzipper = require('unzipper')

// Dynamically import libxml2-wasm
let libxml2Wasm: any = null
const getLibxml2Wasm = async () => {
  if (!libxml2Wasm) {
    libxml2Wasm = await import('libxml2-wasm')
  }
  return libxml2Wasm
}

function ensureFileIsPassed ({ file }: { file: any }, res: any, next: any) {
  if (file != null) {
    next()
  }
}

function handleZipFileUpload ({ file }: { file: any }, res: any, next: any) {
  if (utils.endsWith(file?.originalname.toLowerCase(), '.zip')) {
    if (((file?.buffer) != null) && utils.isChallengeEnabled(challenges.fileWriteChallenge)) {
      const buffer = file.buffer
      const filename = file.originalname.toLowerCase()
      const tempFile = path.join(os.tmpdir(), filename)
      fs.open(tempFile, 'w', function (err: any, fd: any) {
        if (err != null) { next(err) }
        fs.write(fd, buffer, 0, buffer.length, null, function (err: any) {
          if (err != null) { next(err) }
          fs.close(fd, function () {
            fs.createReadStream(tempFile)
              .pipe(unzipper.Parse())
              .on('entry', function (entry: any) {
                const fileName = entry.path
                const absolutePath = path.resolve('uploads/complaints/' + fileName)
                challengeUtils.solveIf(challenges.fileWriteChallenge, () => { return absolutePath === path.resolve('ftp/legal.md') })
                if (absolutePath.includes(path.resolve('.'))) {
                  entry.pipe(fs.createWriteStream('uploads/complaints/' + fileName).on('error', function (err: any) { next(err) }))
                } else {
                  entry.autodrain()
                }
              }).on('error', function (err: unknown) { next(err) })
          })
        })
      })
    }
    res.status(204).end()
  } else {
    next()
  }
}

function checkUploadSize ({ file }: { file: any }, res: any, next: any) {
  if (file != null) {
    challengeUtils.solveIf(challenges.uploadSizeChallenge, () => { return file?.size > 100000 })
  }
  next()
}

function checkFileType ({ file }: { file: any }, res: any, next: any) {
  const fileType = file?.originalname.substr(file.originalname.lastIndexOf('.') + 1).toLowerCase()
  challengeUtils.solveIf(challenges.uploadTypeChallenge, () => {
    return !(fileType === 'pdf' || fileType === 'xml' || fileType === 'zip')
  })
  next()
}

async function handleXmlUpload ({ file }: { file: any }, res: any, next: any) {
  if (utils.endsWith(file?.originalname.toLowerCase(), '.xml')) {
    challengeUtils.solveIf(challenges.deprecatedInterfaceChallenge, () => { return true })
    if (((file?.buffer) != null) && utils.isChallengeEnabled(challenges.deprecatedInterfaceChallenge)) { // XXE attacks in Docker/Heroku containers regularly cause "segfault" crashes
      const data = file.buffer.toString()
      try {
        const libxml2 = await getLibxml2Wasm() // Dynamically import libxml2-wasm
        const { XmlDocument, ParseOption } = libxml2 // Destructure needed components
        const sandbox = { libxml: XmlDocument, data, ParseOption }
        vm.createContext(sandbox)
        // Parsing XML with options
        const xmlDoc = vm.runInContext('libxml.fromString(data, { option: ParseOption.XML_PARSE_NOBLANKS | ParseOption.XML_PARSE_NOENT | ParseOption.XML_PARSE_NOCDATA })', sandbox, { timeout: 2000 })
        const xmlString = xmlDoc.toString({ format: false })
        challengeUtils.solveIf(challenges.xxeFileDisclosureChallenge, () => { return (utils.matchesEtcPasswdFile(xmlString) || utils.matchesSystemIniFile(xmlString)) })
        res.status(410)
        next(new Error('B2B customer complaints via file upload have been deprecated for security reasons: ' + utils.trunc(xmlString, 400) + ' (' + file.originalname + ')'))
        xmlDoc.dispose() // Dispose of xmlDoc to prevent memory leaks
      } catch (err: any) {
        if (utils.contains(err.message, 'Script execution timed out')) {
          if (challengeUtils.notSolved(challenges.xxeDosChallenge)) {
            challengeUtils.solve(challenges.xxeDosChallenge)
          }
          res.status(503)
          next(new Error('Sorry, we are temporarily not available! Please try again later.'))
        } else {
          res.status(410)
          next(new Error('B2B customer complaints via file upload have been deprecated for security reasons: ' + err.message + ' (' + file.originalname + ')'))
        }
      }
    } else {
      res.status(410)
      next(new Error('B2B customer complaints via file upload have been deprecated for security reasons (' + file?.originalname + ')'))
    }
  }
  res.status(204).end()
}

module.exports = {
  ensureFileIsPassed,
  handleZipFileUpload,
  checkUploadSize,
  checkFileType,
  handleXmlUpload
}
