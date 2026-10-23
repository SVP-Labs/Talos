local count = require("count")

describe("count", function()
    it("doubles", function()
        assert.are.equal(4, count.twice(2))
    end)
end)
