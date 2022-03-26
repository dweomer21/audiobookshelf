const axios = require('axios')
const fs = require('fs-extra')
const Logger = require('../Logger')
const { parsePodcastRssFeedXml } = require('../utils/podcastUtils')
const LibraryItem = require('../objects/LibraryItem')
const { getFileTimestampsWithIno } = require('../utils/fileUtils')
const filePerms = require('../utils/filePerms')

class PodcastController {

  async create(req, res) {
    if (!req.user.isRoot) {
      Logger.error(`[PodcastController] Non-root user attempted to create podcast`, req.user)
      return res.sendStatus(500)
    }
    const payload = req.body

    const library = this.db.libraries.find(lib => lib.id === payload.libraryId)
    if (!library) {
      Logger.error(`[PodcastController] Create: Library not found "${payload.libraryId}"`)
      return res.status(400).send('Library not found')
    }

    const folder = library.folders.find(fold => fold.id === payload.folderId)
    if (!folder) {
      Logger.error(`[PodcastController] Create: Folder not found "${payload.folderId}"`)
      return res.status(400).send('Folder not found')
    }

    var podcastPath = payload.path.replace(/\\/g, '/')
    if (await fs.pathExists(podcastPath)) {
      Logger.error(`[PodcastController] Attempt to create podcast when folder path already exists "${podcastPath}"`)
      return res.status(400).send('Path already exists')
    }

    var success = await fs.ensureDir(podcastPath).then(() => true).catch((error) => {
      Logger.error(`[PodcastController] Failed to ensure podcast dir "${podcastPath}"`, error)
      return false
    })
    if (!success) return res.status(400).send('Invalid podcast path')
    await filePerms.setDefault(podcastPath)

    var libraryItemFolderStats = await getFileTimestampsWithIno(podcastPath)

    var relPath = payload.path.replace(folder.fullPath, '')
    if (relPath.startsWith('/')) relPath = relPath.slice(1)

    const libraryItemPayload = {
      path: podcastPath,
      relPath,
      folderId: payload.folderId,
      libraryId: payload.libraryId,
      ino: libraryItemFolderStats.ino,
      mtimeMs: libraryItemFolderStats.mtimeMs || 0,
      ctimeMs: libraryItemFolderStats.ctimeMs || 0,
      birthtimeMs: libraryItemFolderStats.birthtimeMs || 0,
      media: payload.media
    }

    var libraryItem = new LibraryItem()
    libraryItem.setData('podcast', libraryItemPayload)

    // Download and save cover image
    if (payload.media.metadata.imageUrl) {
      // TODO: Scan cover image to library files
      var coverResponse = await this.coverManager.downloadCoverFromUrl(libraryItem, payload.media.metadata.imageUrl)
      if (coverResponse) {
        if (coverResponse.error) {
          Logger.error(`[PodcastController] Download cover error from "${payload.media.metadata.imageUrl}": ${coverResponse.error}`)
        } else if (coverResponse.cover) {
          libraryItem.media.coverPath = coverResponse.cover
        }
      }
    }

    await this.db.insertLibraryItem(libraryItem)
    this.emitter('item_added', libraryItem.toJSONExpanded())

    res.json(libraryItem.toJSONExpanded())

    if (payload.episodesToDownload && payload.episodesToDownload.length) {
      Logger.info(`[PodcastController] Podcast created now starting ${payload.episodesToDownload.length} episode downloads`)
      this.podcastManager.downloadPodcastEpisodes(libraryItem, payload.episodesToDownload)
    }
  }

  getPodcastFeed(req, res) {
    var url = req.body.rssFeed
    if (!url) {
      return res.status(400).send('Bad request')
    }

    axios.get(url).then(async (data) => {
      if (!data || !data.data) {
        Logger.error('Invalid podcast feed request response')
        return res.status(500).send('Bad response from feed request')
      }
      var podcast = await parsePodcastRssFeedXml(data.data)
      if (!podcast) {
        return res.status(500).send('Invalid podcast RSS feed')
      }
      res.json(podcast)
    }).catch((error) => {
      console.error('Failed', error)
      res.status(500).send(error)
    })
  }
}
module.exports = new PodcastController()