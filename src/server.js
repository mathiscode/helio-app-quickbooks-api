/* Helio Quickbooks API App */

const Package = require('../package.json')
const fs = require('fs')
const os = require('os')
const jwt = require('jsonwebtoken')
const path = require('path')
const faker = require('faker')
const OAuthClient = require('intuit-oauth')

const App = class {
  constructor (router, logger, mongoose, options) {
    this.options = typeof options === 'object' ? options : {}
    this.package = Package
    this.router = router
    this.log = logger
    this.mongoose = mongoose

    this.name = this.options.name || 'Helio Quickbooks API'
    this.root = this.options.root || '/apps/quickbooks'

    // Setup CORS Allowed Origins
    this.corsAllowedOrigins = this.options.corsAllowedOrigins || ['http://localhost:3000/']

    // Setup the OAuth client
    this.oauth = new OAuthClient({
      clientId: process.env.INTUIT_CLIENT_ID,
      clientSecret: process.env.INTUIT_CLIENT_SECRET,
      environment: process.env.INTUIT_API_ENVIRONMENT || 'sandbox',
      redirectUri: process.env.INTUIT_APP_CALLBACK_DOMAIN_ROOT + '/apps/quickbooks/callback',
      logging: process.env.INTUIT_API_LOGGING === 'true'
    })

    this.router.appComms.on('qbo:get:customers', async () => {
      const customers = await this.getAllCustomers()
      this.router.appComms.emit('qbo:result:customers', customers)
    })

    const decodeUserToken = (req, res, next) => {
      const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null
      if (!token) return res.status(401).send('Unauthorized')

      jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
        if (err) return next(err)
        if (payload.data.uuid) req.user = payload.data
        return next()
      })
    }

    // this.router.all('*', (req, res, next) => {
    //   const { params, query, body } = req
    //   console.log({ params, query, body })
    //   return next()
    // })

    this.router.get('/', decodeUserToken, this.qbStatus.bind(this))
    this.router.get('/authorize', decodeUserToken, this.authorize.bind(this))
    this.router.get('/callback', this.intuitCallback.bind(this))
    this.router.get('/token/refresh', decodeUserToken, this.doRefreshToken.bind(this))
    this.router.get('/token/valid', decodeUserToken, this.isTokenValid.bind(this))
    this.router.get('/company', decodeUserToken, this.getCompanyInfo.bind(this))
    this.router.get('/customers', decodeUserToken, this.getCustomers.bind(this))

    this.router.get('/customers/generate', decodeUserToken, this.generateFakeCustomers.bind(this))

    // Load AccessToken from filesystem during development
    try {
      const data = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'helio-qbo-token')).toString())
      this.log.silly('Read locally stored QBO access token')
      this.setAccessToken(data)
      this.refreshToken()
    } catch (err) {
      this.log.silly('Did not find a locally stored QBO access token')
    }

    // Sneaky-sneaky refresh token automatically during development
    setInterval(() => {
      this.refreshToken()
    }, 1800000)
  }

  setAccessToken (token) {
    this.oauth.setToken(token)
    fs.writeFile(path.join(os.tmpdir(), 'helio-qbo-token'), JSON.stringify(token), err => {
      if (err) console.error(err)
    })
  }

  async refreshToken () {
    const authResponse = await this.oauth.refresh()
    this.setAccessToken(authResponse.token)
    this.log.info(this.name, { message: 'Successfully refreshed access token!' })
    return authResponse.token
  }

  async quickbooks ({ action, query, urlParams, method, headers, body }) {
    try {
      const companyID = this.oauth.getToken().realmId
      if (!companyID) throw new Error('No company ID. Not connected to QB?')

      const url = this.oauth.environment === 'sandbox' ? OAuthClient.environment.sandbox : OAuthClient.environment.production
      const apiUrl = `${url}v3/company/${companyID}/${action}${urlParams || ''}${query || ''}`

      this.log.debug(`Contacting QB: ${apiUrl}`)

      const authResponse = await this.oauth.makeApiCall({
        method: method || 'GET',
        url: apiUrl,
        headers,
        body
      })

      if (authResponse.json.fault) throw new Error(authResponse.json.fault.error)
      return authResponse.json
    } catch (err) {
      if (err.error) throw new Error(err.error)
      throw err
    }
  }

  async getAllCustomers () {
    const customers = []

    const results = await this.quickbooks({ action: 'query', query: '?query=SELECT * FROM Customer MAXRESULTS 1000' })
    customers.push(...results.QueryResponse.Customer)
    const initialMaxResults = parseInt(results.QueryResponse.maxResults)

    if (initialMaxResults === 1000) {
      let maxResults = initialMaxResults
      while (maxResults === 1000) {
        const results = await this.quickbooks({ action: 'query', query: `?query=SELECT * FROM Customer STARTPOSITION ${maxResults} MAXRESULTS 1000` })
        customers.push(...results.QueryResponse.Customer)
        maxResults = parseInt(results.QueryResponse.maxResults)
      }
    }

    return customers
  }

  // Begin routes

  qbStatus (req, res) {
    res.json({
      appAuthorized: false,
      oauthToken: null
    })
  }

  authorize (req, res, next) {
    res.send(this.oauth.authorizeUri({
      state: (Math.random() * Date.now()).toString(36),
      scope: [OAuthClient.scopes.Accounting]
    }))
  }

  intuitCallback (req, res, next) {
    this.oauth.createToken(req.url)
      .then(authResponse => {
        this.setAccessToken(authResponse.token)
        // res.redirect('/')
        res.redirect('http://localhost:3000/') // for development
      })
      .catch(err => {
        this.log.error(err)
        return next(err)
      })
  }

  getToken (req, res) {
    res.json(this.oauth.getToken())
  }

  async doRefreshToken (req, res, next) {
    try {
      const token = await this.refreshToken()
      res.send(token)
    } catch (err) {
      this.log.error(this.name, { err: err.toString() })
      res.status(401).json({ error: err.toString() })
    }
  }

  async isTokenValid (req, res, next) {
    res.json(this.oauth.isAccessTokenValid())
  }

  async getCompanyInfo (req, res, next) {
    try {
      const results = await this.quickbooks({
        action: 'companyinfo',
        urlParams: `/${this.oauth.getToken().realmId}`
      })

      res.json(results)
    } catch (err) {
      this.log.error('[Helio Quickbooks]', { err: err.Fault ? err.Fault : err })
      res.status(400).json(err)
    }
  }

  async getCustomers (req, res) {
    try {
      const results = await this.getAllCustomers()
      res.json(results)
    } catch (err) {
      this.log.error('Helio Quickbooks', { err: err.Fault ? err.Fault : err })
      res.status(400).json(err.Fault ? err.Fault : err)
    }
  }

  async generateFakeCustomers (req, res) {
    const makeFake = () => {
      return {
        GivenName: faker.name.firstName(),
        FamilyName: faker.name.lastName(),
        CompanyName: faker.company.companyName(),
        Notes: 'This is a fake customer generated for testing purposes',
        PrimaryEmailAddr: {
          Address: faker.internet.email()
        },
        PrimaryPhone: {
          FreeFormNumber: faker.phone.phoneNumber()
        },
        BillAddr: {
          Line1: faker.address.streetAddress(),
          City: faker.address.city(),
          CountrySubDivisionCode: faker.address.stateAbbr()
        }
      }
    }

    const fakeCustomers = new Array(parseInt(req.query.amount) || 0).fill(null).map(makeFake)
    fakeCustomers.forEach(async customer => {
      try {
        await this.quickbooks({
          action: 'customer',
          method: 'POST',
          body: customer
        })

        this.log.silly(this.name, { message: `Added a fake customer (${customer.GivenName} ${customer.FamilyName}) to Quickbooks!` })
      } catch (err) {
        this.log.error(err.Fault ? err.Fault : err)
      }
    })

    res.send('Job running!')
  }
}

module.exports = App
