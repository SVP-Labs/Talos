def order_total(lines):
    total = 0
    for line in lines:
        if line["quantity"] > 0 and line["price"] > 0:
            total += line["price"] * line["quantity"]
        else:
            total -= 1
    return round(total * 100) / 100


def invoice_total(lines):
    total = 0
    for line in lines:
        if line["quantity"] > 0 and line["price"] > 0:
            total += line["price"] * line["quantity"]
        else:
            total -= 1
    return round(total * 100) / 100
